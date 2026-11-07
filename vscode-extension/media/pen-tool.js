'use strict';
// The Pen (P): a board tool, not Compositor's, which has no pen or path tool (its Shape tool draws rectangles, ellipses
// and lines). Two ways to draw, Tab switches, as Photoshop's Curvature Pen and Pen:
//   Curvature  each click places a point and the path runs smoothly through all of them; a double-click or an
//              Option-click places a corner; dragging a new point moves it.
//   Pen        a click places a corner and a drag pulls out a smooth point's handles.
// Shift keeps a segment at 45° steps; clicking the first point closes the path, Return finishes an open one, Delete
// takes the last point back and Escape drops the path. The path becomes a new layer, "Path N", stroked with the
// foreground color and/or (closed) filled with the background color: ordinary pixels to Compositor and to Claude.
// The board keeps the path in <name>.comp.board.json (layer-ops.js saveBoardState), so while the layer still shows what
// its path draws the Pen reshapes it: drag a point (a curvature path smooths itself around it), click a segment to add
// a point and drag to bend it, Option-click (or double-click) a point to make it a corner or smooth, Delete removes the
// selected point; in Pen mode the handles show and can be dragged (Option moves one alone). Painting on the layer, a
// filter, or an edit made in Compositor or by Claude leaves plain pixels.

(function () {
    const CB = (window.CB = window.CB || {});
    const { Transform, Affine } = CB;

    const KINDS = ['Curvature', 'Pen'];
    const MODES = ['Stroke', 'Fill', 'Stroke & Fill'];
    // Screen points within which a press takes a point, a handle or a segment.
    const HIT = 7;
    // How far a curvature point's handles reach toward its neighbors, as a share of the distance to each.
    const TENSION = 0.36;
    // Versions kept per layer, so undoing an edit leaves the earlier path editable.
    const VERSIONS = 20;
    const MAX_PIXELS = 100e6;

    const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const css = (c) => `rgb(${c.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(',')})`;
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const strokes = (mode) => mode !== 'Fill';
    const fills = (mode) => mode !== 'Stroke';
    const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

    // A point is its anchor (x, y) and two handles, (inX, inY) toward the previous point and (outX, outY) toward the
    // next; a corner's handles sit on the anchor. A curvature path's points may be marked `corner`.
    const corner = (x, y, extra = {}) => ({ ...extra, x, y, inX: x, inY: y, outX: x, outY: y });
    const hasIn = (p) => p.inX !== p.x || p.inY !== p.y;
    const hasOut = (p) => p.outX !== p.x || p.outY !== p.y;
    const mapPoint = (p, f) => {
        const a = f(p.x, p.y), i = f(p.inX, p.inY), o = f(p.outX, p.outY);
        return { ...p, x: a.x, y: a.y, inX: i.x, inY: i.y, outX: o.x, outY: o.y };
    };
    const isCurvature = (v) => v.kind === 'Curvature';

    // Curvature: every point's handles follow the line from the point before it to the point after it, reaching toward
    // each by TENSION of the way, so the path runs smoothly through the points. Corners and the ends of an open path
    // have none.
    function smooth(points, closed) {
        const n = points.length;
        return points.map((p, i) => {
            const prev = i > 0 ? points[i - 1] : closed ? points[n - 1] : null;
            const next = i < n - 1 ? points[i + 1] : closed ? points[0] : null;
            const dx = next ? next.x - (prev || p).x : 0, dy = next ? next.y - (prev || p).y : 0, d = Math.hypot(dx, dy);
            if (p.corner || !prev || !next || prev === next || !d) return corner(p.x, p.y, p.corner ? { corner: true } : {});
            const ux = dx / d, uy = dy / d;
            const back = Math.hypot(p.x - prev.x, p.y - prev.y) * TENSION, ahead = Math.hypot(next.x - p.x, next.y - p.y) * TENSION;
            return { ...p, inX: p.x - ux * back, inY: p.y - uy * back, outX: p.x + ux * ahead, outY: p.y + uy * ahead };
        });
    }

    // The segment from `a` to `b` at t (de Casteljau): the point and both halves' new handles.
    function split(a, b, t) {
        const P0 = { x: a.x, y: a.y }, P1 = { x: a.outX, y: a.outY }, P2 = { x: b.inX, y: b.inY }, P3 = { x: b.x, y: b.y };
        const Q0 = lerp(P0, P1, t), Q1 = lerp(P1, P2, t), Q2 = lerp(P2, P3, t), R0 = lerp(Q0, Q1, t), R1 = lerp(Q1, Q2, t);
        return { at: lerp(R0, R1, t), aOut: Q0, in: R0, out: R1, bIn: Q2 };
    }

    // `labels` shortens what a button shows (the narrow options bar), by value.
    function segmented(values, current, attr, help, labels = {}) {
        return `<span class="segmented"${help ? ` title="${escape(help)}"` : ''}>${values.map((v) => `<button data-${attr}="${escape(v)}" class="${v === current ? 'on' : ''}">${escape(labels[v] || v)}</button>`).join('')}</span>`;
    }

    // Shift: `to` at the nearest 45° step around `from`.
    function constrain(from, to) {
        const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
    }

    // The path through `points` as cubic segments; `f` maps a point's coordinates onto the context.
    function trace(ctx, points, closed, f) {
        const start = f(points[0].x, points[0].y);
        ctx.moveTo(start.x, start.y);
        const segment = (a, b) => {
            const c1 = f(a.outX, a.outY), c2 = f(b.inX, b.inY), end = f(b.x, b.y);
            ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
        };
        for (let i = 1; i < points.length; i++) segment(points[i - 1], points[i]);
        if (closed) {
            segment(points[points.length - 1], points[0]);
            ctx.closePath();
        }
    }

    // A version's look: the fill first (closed paths only), then the stroke, round joins and caps. `scale` turns its
    // width into the context's units.
    function paint(ctx, v, f = (x, y) => ({ x, y }), scale = 1) {
        if (v.points.length < 2) return;
        if (fills(v.mode) && v.closed) {
            ctx.beginPath();
            trace(ctx, v.points, true, f);
            ctx.fillStyle = css(v.fill);
            ctx.fill('nonzero');
        }
        if (strokes(v.mode)) {
            ctx.beginPath();
            trace(ctx, v.points, v.closed, f);
            ctx.lineWidth = v.width * scale;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.strokeStyle = css(v.stroke);
            ctx.stroke();
        }
    }

    // A version's pixels, its size the layer's pixel grid.
    function render(v) {
        const canvas = new OffscreenCanvas(Math.max(1, v.size[0]), Math.max(1, v.size[1]));
        // willReadFrequently keeps Chromium on its CPU rasterizer, so the pixels are the same every time.
        paint(canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true }), v);
        return canvas;
    }

    // The whole-pixel box around every point and handle (a curve never leaves it), widened by half the stroke.
    function bounds(points, mode, width) {
        const xs = points.flatMap((p) => [p.x, p.inX, p.outX]), ys = points.flatMap((p) => [p.y, p.inY, p.outY]);
        const pad = (strokes(mode) ? width / 2 : 0) + 2;
        const x = Math.floor(Math.min(...xs) - pad), y = Math.floor(Math.min(...ys) - pad);
        return { x, y, width: Math.max(1, Math.ceil(Math.max(...xs) + pad) - x), height: Math.max(1, Math.ceil(Math.max(...ys) + pad) - y) };
    }

    // Whether `image` still shows what `v` draws (Shapes.samePixels: the same grid and pixels, give or take a PNG round
    // trip).
    function shows(image, v) {
        if (!image || image.deep || !v || !v.size || image.width !== v.size[0] || image.height !== v.size[1]) return false;
        return CB.Shapes.samePixels(image, render(v));
    }

    class PenTool {
        constructor(board) {
            this.board = board;
            this.settings = { kind: 'Curvature', mode: 'Stroke', width: 4 };
            // The new path while it is drawn, in document pixels: { kind, points, closed }; a curvature draft's handles
            // are worked out from its points (drafted).
            this.draft = null;
            // The press being dragged, and the edited path while a drag changes it.
            this.drag = null;
            // The last press, for double-clicks.
            this.lastPress = null;
            this.live = null;
            this.hoverDoc = null;
            this.hoverScreen = null;
            // The selected point of the edited path.
            this.selected = null;
            // The active layer's path, worked out again only when the layer or the history changes.
            this.cache = null;
        }

        // -------------------------------------------------------------------------------------------------------------
        // The edited path

        // The active layer's path while its pixels still show one of its versions (the latest that does):
        // { record, version, t, toDoc, toLocal }, the version in the layer's pixel grid.
        editable() {
            const board = this.board, record = board.activeLayer();
            if (this.draft || !record || record.isGroup || record.adjustment || record.text || record.shape) return null;
            if (board.selectedIDs.size > 1 || board.isMaskSelected || !board.effectivelyVisible(record)) return null;
            const versions = board.paths && board.paths[record.id];
            const image = board.doc.entry(record.id).image;
            if (!versions || !versions.length || !image) return null;
            const h = board.history, last = h.done[h.done.length - 1] || null, c = this.cache;
            if (!(c && c.id === record.id && c.image === image && c.last === last && c.undone === h.undone.length && c.versions === versions.length)) {
                let found = null;
                for (let i = versions.length - 1; i >= 0 && !found; i--) if (shows(image, versions[i])) found = versions[i];
                this.cache = { id: record.id, image, last, undone: h.undone.length, versions: versions.length, version: found };
            }
            if (!this.cache.version) return null;
            const t = board.layerTransform(record);
            const toDoc = Transform.pixelToDocument(t, image.width, image.height);
            return { record, version: this.cache.version, t, toDoc, toLocal: Affine.invert(toDoc) };
        }

        screenOf(edit) {
            const view = this.board.view;
            return (x, y) => view.toScreen(Affine.apply(edit.toDoc, x, y));
        }

        // Handles show (and can be dragged) on a Pen path, and on a curvature path while the Pen mode is chosen.
        handlesShown(v) {
            return !isCurvature(v) || this.settings.kind === 'Pen';
        }

        // The handle or point of the edited path under a screen point: handles first, as they can lie on a point.
        hitEdit(edit, p) {
            const f = this.screenOf(edit), pts = edit.version.points;
            const near = (x, y) => { const s = f(x, y); return Math.hypot(s.x - p.x, s.y - p.y) <= HIT; };
            if (this.handlesShown(edit.version)) {
                for (let i = pts.length - 1; i >= 0; i--) {
                    if (hasOut(pts[i]) && near(pts[i].outX, pts[i].outY)) return { kind: 'out', index: i };
                    if (hasIn(pts[i]) && near(pts[i].inX, pts[i].inY)) return { kind: 'in', index: i };
                }
            }
            for (let i = pts.length - 1; i >= 0; i--) if (near(pts[i].x, pts[i].y)) return { kind: 'anchor', index: i };
            return null;
        }

        // The segment of the edited path under a screen point: { index (the point it starts at), t }.
        hitSegment(edit, p) {
            const f = this.screenOf(edit), pts = edit.version.points, n = pts.length;
            let best = null;
            const count = edit.version.closed ? n : n - 1;
            for (let i = 0; i < count; i++) {
                const a = pts[i], b = pts[(i + 1) % n];
                for (let k = 1; k < 48; k++) {
                    const t = k / 48, q = split(a, b, t).at, s = f(q.x, q.y), d = Math.hypot(s.x - p.x, s.y - p.y);
                    if (d <= HIT && (!best || d < best.d)) best = { index: i, t, d };
                }
            }
            return best;
        }

        // A new point on segment `index` at t, the path's look unchanged until it moves (a curvature path smooths
        // itself around it). Returns the new point's index.
        insertPoint(v, index, t) {
            const pts = v.points, a = pts[index], b = pts[(index + 1) % pts.length], s = split(a, b, t);
            const point = { x: s.at.x, y: s.at.y, inX: s.in.x, inY: s.in.y, outX: s.out.x, outY: s.out.y };
            if (!isCurvature(v)) {
                a.outX = s.aOut.x; a.outY = s.aOut.y;
                b.inX = s.bIn.x; b.inY = s.bIn.y;
            }
            pts.splice(index + 1, 0, point);
            if (isCurvature(v)) v.points = smooth(pts, v.closed);
            return index + 1;
        }

        // An edited version as the layer: its pixels re-rendered on a grid fitted to it, placed so nothing moves on the
        // canvas, one undo step "Edit Path". A mask following the old grid stays where it was.
        commitEdit(edit, v) {
            const board = this.board, record = edit.record, entry = board.doc.entry(record.id), old = entry.image;
            if (board.refuseLocked([record])) return false;
            const box = bounds(v.points, v.mode, v.width);
            if (box.width * box.height > MAX_PIXELS) {
                board.toast('That path would make a layer too large. Bring its points or handles closer.');
                return false;
            }
            const next = { ...clone(v), points: v.points.map((p) => mapPoint(p, (x, y) => ({ x: x - box.x, y: y - box.y }))), size: [box.width, box.height] };
            const image = render(next);
            const t = edit.t, sx = t.width / old.width, sy = t.height / old.height;
            const c = Affine.apply(edit.toDoc, box.x + box.width / 2, box.y + box.height / 2);
            const placed = { ...t, width: box.width * sx, height: box.height * sy };
            placed.x = c.x - placed.width / 2;
            placed.y = c.y - placed.height / 2;
            const list = board.paths[record.id] || [];
            list.push(next);
            while (list.length > VERSIONS) list.shift();
            board.paths[record.id] = list;
            board.edit('Edit Path', () => {
                if (record.maskFile && entry.mask && !record.maskPlacement) record.maskPlacement = Transform.write(t);
                record.transform = Transform.write(placed);
                entry.image = image;
                board.doc.dirtyImages.add(record.id);
                return [{ layerID: record.id, kind: 'image', beforeBitmap: old, afterBitmap: image }];
            });
            board.saveBoardState();
            this.cache = null;
            return true;
        }

        // Option-click (or a double-click on a curvature path): a smooth point becomes a corner and a corner smooth.
        // A Pen path's corner gets handles along its neighbors, a third of the way.
        toggleSmooth(edit, index) {
            const v = clone(edit.version), pts = v.points, p = pts[index];
            if (isCurvature(v)) {
                if (p.corner) delete p.corner;
                else p.corner = true;
                v.points = smooth(pts, v.closed);
            } else if (hasIn(p) || hasOut(p)) {
                Object.assign(p, corner(p.x, p.y));
            } else {
                const prev = pts[index - 1] || (v.closed ? pts[pts.length - 1] : null);
                const next = pts[index + 1] || (v.closed ? pts[0] : null);
                const a = prev || p, b = next || p;
                const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
                const ux = dx / length, uy = dy / length;
                const back = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) / 3 : 0, ahead = next ? Math.hypot(next.x - p.x, next.y - p.y) / 3 : 0;
                p.inX = p.x - ux * back; p.inY = p.y - uy * back;
                p.outX = p.x + ux * ahead; p.outY = p.y + uy * ahead;
            }
            this.selected = index;
            this.commitEdit(edit, v);
        }

        deletePoint(edit, index) {
            const v = clone(edit.version);
            if (v.points.length <= (v.closed ? 3 : 2)) {
                this.board.toast(`A ${v.closed ? 'closed path needs 3' : 'path needs 2'} points. Delete the layer to remove the whole path.`);
                return;
            }
            v.points.splice(index, 1);
            if (isCurvature(v)) v.points = smooth(v.points, v.closed);
            this.selected = null;
            this.commitEdit(edit, v);
        }

        // -------------------------------------------------------------------------------------------------------------
        // The new path

        style() {
            const board = this.board;
            return { mode: this.settings.mode, width: this.settings.width, stroke: [...board.colors.fg], fill: [...board.colors.bg] };
        }

        // The draft's points with their handles: a curvature draft's worked out, with `extra` (the pointer) as a
        // would-be last point.
        drafted(extra = null) {
            const d = this.draft;
            const pts = extra ? [...d.points, corner(extra.x, extra.y)] : d.points;
            return isCurvature(d) ? smooth(pts, d.closed && !extra) : pts;
        }

        // The draft as a layer above the active one; a fill-only path has to be closed first.
        finishDraft() {
            const board = this.board, d = this.draft;
            if (!d) return false;
            if (d.points.length < 2) {
                this.dropDraft();
                return false;
            }
            const style = this.style();
            if (!d.closed && !strokes(style.mode)) {
                board.toast('Close the path (click its first point) to fill it, or choose Stroke.');
                return false;
            }
            if (!board.canEditLayers()) return false;
            const points = this.drafted();
            const box = bounds(points, style.mode, style.width);
            if (box.width * box.height > MAX_PIXELS) {
                board.toast('That path would make a layer too large.');
                return false;
            }
            const version = {
                ...style, kind: d.kind, closed: d.closed, size: [box.width, box.height],
                points: points.map((p) => mapPoint(p, (x, y) => ({ x: x - box.x, y: y - box.y }))),
            };
            this.draft = null;
            const id = board.actions.addPathLayer({
                image: render(version),
                transform: { x: box.x, y: box.y, width: box.width, height: box.height, rotation: 0, flipX: false, flipY: false, sampling: 'High quality' },
            });
            if (id) {
                board.paths[id] = [version];
                board.saveBoardState();
            }
            this.selected = null;
            this.cache = null;
            board.renderOptions(true);
            board.view.drawOverlay();
            return Boolean(id);
        }

        dropDraft() {
            this.draft = null;
            this.drag = null;
            this.board.renderOptions(true);
            this.board.view.drawOverlay();
        }

        nearPoint(p, point) {
            const s = this.board.view.toScreen(point);
            return Math.hypot(s.x - p.x, s.y - p.y) <= HIT;
        }

        nearFirst(p) {
            const pts = this.draft && this.draft.points;
            return Boolean(pts && pts.length >= 2 && this.nearPoint(p, pts[0]));
        }

        // -------------------------------------------------------------------------------------------------------------
        // Pointer

        // A second press at the same spot soon after the first (pointerdown carries no click count).
        isDouble(p) {
            const last = this.lastPress, now = performance.now();
            this.lastPress = { p, time: now };
            return Boolean(last && now - last.time < 500 && Math.hypot(p.x - last.p.x, p.y - last.p.y) <= HIT);
        }

        down(doc, p, e) {
            const board = this.board;
            if (board.working) return true;
            const double = this.isDouble(p);
            if (!this.draft) {
                const edit = this.editable();
                if (edit && this.editPress(edit, doc, p, e, double)) return true;
                // Command-click picks the path layer under the pointer.
                if (e.metaKey) {
                    const under = board.layerUnder(doc);
                    if (under && board.paths[under.id]) board.selectLayer(under.id);
                    this.selected = null;
                    board.renderOptions(true);
                    board.view.drawOverlay();
                    return true;
                }
                this.selected = null;
                this.draft = { kind: this.settings.kind, points: [], closed: false };
                board.renderOptions(true);
            }
            const d = this.draft, pts = d.points;
            if (this.nearFirst(p)) {
                d.closed = true;
                this.drag = { kind: 'close', index: 0, press: p };
                return true;
            }
            if (isCurvature(d)) {
                // The second press of a double-click on the point just placed makes it a corner.
                if (double && pts.length && this.nearPoint(p, pts[pts.length - 1])) {
                    const last = pts[pts.length - 1];
                    if (last.corner) delete last.corner;
                    else last.corner = true;
                    board.view.drawOverlay();
                    return true;
                }
                const at = e.shiftKey && pts.length ? constrain(pts[pts.length - 1], doc) : doc;
                pts.push(corner(at.x, at.y, e.altKey ? { corner: true } : {}));
                this.drag = { kind: 'place', index: pts.length - 1, press: p };
            } else {
                const at = e.shiftKey && pts.length ? constrain(pts[pts.length - 1], doc) : doc;
                pts.push(corner(at.x, at.y));
                this.drag = { kind: 'new', index: pts.length - 1, press: p };
            }
            board.renderOptions(true);
            board.view.drawOverlay();
            return true;
        }

        // A press on the edited path: a point or a handle to drag, a segment to add a point on (and bend it by dragging
        // that point). True when it took the press.
        editPress(edit, doc, p, e, double) {
            const board = this.board;
            const hit = this.hitEdit(edit, p);
            const segment = !hit && this.hitSegment(edit, p);
            if (!hit && !segment) return false;
            if (board.refuseLocked([edit.record])) return true;
            if (hit && hit.kind === 'anchor' && (e.altKey || (double && isCurvature(edit.version)))) {
                this.toggleSmooth(edit, hit.index);
                return true;
            }
            const version = clone(edit.version);
            let index = hit ? hit.index : null, kind = hit ? hit.kind : 'anchor';
            if (segment) index = this.insertPoint(version, segment.index, segment.t);
            // Dragging a curvature path's handle (Pen mode) makes it a Pen path, its handles its own from then on.
            if (kind !== 'anchor' && isCurvature(version)) version.kind = 'Pen';
            this.selected = index;
            this.live = { ...edit, version };
            const start = Affine.apply(edit.toLocal, doc.x, doc.y);
            this.drag = { kind, index, start, origin: { ...version.points[index] }, alone: e.altKey, moved: Boolean(segment) };
            board.view.drawOverlay();
            return true;
        }

        move(doc, p, e) {
            const drag = this.drag;
            if (!drag) return;
            if (drag.kind === 'place') {
                // Dragging a curvature point just placed moves it.
                const pts = this.draft.points, point = pts[drag.index];
                const at = e.shiftKey && drag.index > 0 ? constrain(pts[drag.index - 1], doc) : doc;
                Object.assign(point, corner(at.x, at.y, point.corner ? { corner: true } : {}));
                this.board.view.drawOverlay();
                return;
            }
            if (drag.kind === 'new' || drag.kind === 'close') {
                if (isCurvature(this.draft)) return;
                // Dragging pulls the point's handles out, the one behind it mirrored.
                const point = this.draft.points[drag.index];
                if (Math.hypot(p.x - drag.press.x, p.y - drag.press.y) < 2) return;
                const h = e.shiftKey ? constrain(point, doc) : doc;
                point.outX = h.x; point.outY = h.y;
                point.inX = 2 * point.x - h.x; point.inY = 2 * point.y - h.y;
                this.board.view.drawOverlay();
                return;
            }
            const live = this.live, v = live.version, local = Affine.apply(live.toLocal, doc.x, doc.y);
            const point = v.points[drag.index], o = drag.origin;
            drag.moved = true;
            if (drag.kind === 'anchor') {
                const dx = local.x - drag.start.x, dy = local.y - drag.start.y;
                Object.assign(point, mapPoint(o, (x, y) => ({ x: x + dx, y: y + dy })));
                if (isCurvature(v)) v.points = smooth(v.points, v.closed);
            } else {
                const h = e.shiftKey ? constrain(o, local) : local;
                const [mine, other] = drag.kind === 'out' ? ['out', 'in'] : ['in', 'out'];
                point[`${mine}X`] = h.x;
                point[`${mine}Y`] = h.y;
                // A smooth point keeps its handles in line, the other keeping its length; Option moves one alone.
                const otherLength = Math.hypot(o[`${other}X`] - o.x, o[`${other}Y`] - o.y);
                const dx = h.x - o.x, dy = h.y - o.y, length = Math.hypot(dx, dy);
                if (!drag.alone && otherLength > 0 && length > 0) {
                    point[`${other}X`] = o.x - (dx / length) * otherLength;
                    point[`${other}Y`] = o.y - (dy / length) * otherLength;
                }
            }
            this.board.view.drawOverlay();
        }

        up() {
            const drag = this.drag;
            this.drag = null;
            if (!drag) return;
            if (drag.kind === 'close') {
                this.finishDraft();
                return;
            }
            if (drag.kind === 'new' || drag.kind === 'place') return;
            const live = this.live;
            this.live = null;
            if (drag.moved && live) this.commitEdit(live, live.version);
            this.board.view.drawOverlay();
        }

        cancel() {
            if (this.drag && this.drag.kind === 'new' && this.draft) {
                const point = this.draft.points[this.drag.index];
                if (point) Object.assign(point, corner(point.x, point.y));
            }
            if (this.drag && this.drag.kind === 'close' && this.draft) this.draft.closed = false;
            this.drag = null;
            this.live = null;
            this.board.view.drawOverlay();
        }

        hover(doc, p) {
            this.hoverDoc = doc;
            this.hoverScreen = p;
            if (this.draft) this.board.view.drawOverlay();
        }

        cursor() {
            const p = this.hoverScreen;
            if (this.drag) return this.drag.kind === 'anchor' || this.drag.kind === 'place' ? 'move' : 'crosshair';
            if (!p) return 'crosshair';
            if (this.draft) return this.nearFirst(p) ? 'cell' : 'crosshair';
            const edit = this.editable();
            const hit = edit && this.hitEdit(edit, p);
            if (hit) return hit.kind === 'anchor' ? 'move' : 'pointer';
            return edit && this.hitSegment(edit, p) ? 'copy' : 'crosshair';
        }

        // -------------------------------------------------------------------------------------------------------------
        // Keys and the board's hooks

        // Tab switches Curvature and Pen for the next path.
        cycle() {
            if (this.draft) return false;
            this.settings.kind = this.settings.kind === 'Curvature' ? 'Pen' : 'Curvature';
            this.board.renderOptions(true);
            this.board.view.drawOverlay();
            return true;
        }

        keydown(e) {
            const apply = CB.Shortcuts && CB.Shortcuts.isApply ? CB.Shortcuts.isApply(e) || e.code === 'NumpadEnter'
                : (e.code === 'Enter' || e.code === 'NumpadEnter') && !e.metaKey && !e.ctrlKey;
            const erase = (e.code === 'Backspace' || e.code === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey;
            if (this.draft) {
                if (apply) { this.finishDraft(); return true; }
                if (erase) { this.takeBack(); return true; }
                return false;
            }
            if (erase && this.selected !== null) {
                const edit = this.editable();
                if (edit && this.selected < edit.version.points.length) {
                    if (!this.board.refuseLocked([edit.record])) this.deletePoint(edit, this.selected);
                    return true;
                }
            }
            return false;
        }

        // The last point of the new path goes (Delete, ⌘Z); the path goes with its last point.
        takeBack() {
            if (!this.draft) return false;
            this.draft.points.pop();
            this.draft.closed = false;
            if (!this.draft.points.length) this.dropDraft();
            else { this.board.renderOptions(true); this.board.view.drawOverlay(); }
            return true;
        }

        escape() {
            if (this.draft) { this.dropDraft(); return true; }
            if (this.selected !== null) { this.selected = null; this.board.view.drawOverlay(); return true; }
            return false;
        }

        interceptUndo() {
            return Boolean(this.draft) && !this.drag && this.takeBack();
        }

        restored() {
            this.cache = null;
            this.selected = null;
        }

        // Switching layers, a filter or another tool keeps a path of two points or more as its layer. A save does not
        // wait for it: the path being drawn is no part of the document yet.
        resolve(reason) {
            if (reason === 'save' || !this.draft || this.drag) return null;
            if (this.draft.points.length < 2 || !this.finishDraft()) this.dropDraft();
            return null;
        }

        deactivate() {
            if (this.draft && (this.draft.points.length < 2 || !this.finishDraft())) this.dropDraft();
            this.selected = null;
            return true;
        }

        busy() {
            return Boolean(this.drag);
        }

        hint() {
            const curvature = (this.draft ? this.draft.kind : this.settings.kind) === 'Curvature';
            const end = 'Click the first point to close · Return finishes · Delete takes back the last point · Escape drops the path';
            if (this.draft) return curvature ? `Click to add points, the path curves through them · Double-click or Option-click: a corner · ${end}` : `Click for a corner, drag for a curve · Shift 45° · ${end}`;
            if (this.editable()) {
                return `Drag points · Click the path to add a point, drag to bend it · Option-click a point: corner or smooth · Delete removes the selected point${this.settings.kind === 'Pen' ? ' · Drag handles (Option: one alone)' : ''}`;
            }
            return curvature ? 'Click to add points, the path curves through them · Tab: Pen · Command-click a path layer to reshape it'
                : 'Click for a corner, drag for a curve · Tab: Curvature · Command-click a path layer to reshape it';
        }

        // -------------------------------------------------------------------------------------------------------------
        // Options bar

        optionsHTML() {
            const board = this.board, s = this.settings, edit = this.draft ? null : this.editable();
            const swatch = (c, label) => `<span class="pen-swatch" title="${label}" style="background:${css(c)}"></span>`;
            const shown = edit ? edit.version : { stroke: board.colors.fg, fill: board.colors.bg };
            return `<span class="title">Pen</span>
                ${segmented(KINDS, this.draft ? this.draft.kind : s.kind, 'pen-kind', 'Curvature: click points and the path curves through them · Pen: click for corners, drag out handles for curves (Tab switches)')}
                ${segmented(MODES, edit ? edit.version.mode : s.mode, 'pen-mode', 'Stroke with the foreground color; fill a closed path with the background color; Both does both', { 'Stroke & Fill': 'Both' })}
                <span class="group"><label class="caption">Width</label><input class="num pen-width" style="width:42px" aria-label="Stroke width"><span class="unit">px</span></span>
                ${swatch(shown.stroke, 'Stroke color')}${swatch(shown.fill, 'Fill color')}
                ${edit ? '<button class="pill pen-recolor" title="Stroke with the foreground color and fill with the background color">Use Current Colors</button>' : ''}
                <span class="spacer"></span>
                ${this.draft ? `<span class="secondary">${this.draft.points.length} point${this.draft.points.length === 1 ? '' : 's'}</span><button class="pill pen-cancel">Cancel</button><button class="pill pen-finish">Finish</button>`
                    : edit ? `<span class="secondary">Editing “${escape(edit.record.name)}”</span>` : ''}`;
        }

        bindOptions(el) {
            const board = this.board, s = this.settings;
            // The options are the next path's; while a path layer is being edited they change it too, one "Edit Path"
            // step each. `settings: false` for what only an edited path has (its colors).
            const change = (apply, { settings = true } = {}) => {
                const edit = this.draft ? null : this.editable();
                if (settings) apply(s);
                if (edit) {
                    const v = clone(edit.version);
                    apply(v);
                    this.commitEdit(edit, v);
                }
                board.renderOptions(true);
                board.view.drawOverlay();
            };
            el.querySelectorAll('[data-pen-kind]').forEach((b) => b.addEventListener('click', () => {
                if (this.draft) return;
                s.kind = b.dataset.penKind;
                board.renderOptions(true);
                board.view.drawOverlay();
            }));
            el.querySelectorAll('[data-pen-mode]').forEach((b) => b.addEventListener('click', () => change((t) => { t.mode = b.dataset.penMode; })));
            el.querySelectorAll('.pen-width').forEach((f) => {
                f.addEventListener('change', () => {
                    const v = Number(f.value);
                    if (Number.isFinite(v) && f.value.trim() !== '') change((t) => { t.width = Math.min(500, Math.max(0.5, v)); });
                    else this.refreshOptions(el);
                });
                f.addEventListener('keydown', (e) => board.fieldKey(e));
            });
            el.querySelectorAll('.pen-recolor').forEach((b) => b.addEventListener('click', () => change((t) => { t.stroke = [...board.colors.fg]; t.fill = [...board.colors.bg]; }, { settings: false })));
            el.querySelectorAll('.pen-cancel').forEach((b) => b.addEventListener('click', () => this.dropDraft()));
            el.querySelectorAll('.pen-finish').forEach((b) => b.addEventListener('click', () => this.finishDraft()));
        }

        refreshOptions(el) {
            const edit = this.draft ? null : this.editable();
            const width = edit ? edit.version.width : this.settings.width;
            el.querySelectorAll('.pen-width').forEach((f) => { if (document.activeElement !== f) f.value = String(Math.round(width * 10) / 10); });
        }

        // -------------------------------------------------------------------------------------------------------------
        // Overlay (CSS pixels)

        drawOverlay(ctx) {
            const board = this.board, view = board.view;
            const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0a84ff';
            if (this.draft) {
                const d = this.draft;
                if (!d.points.length) return;
                const f = (x, y) => view.toScreen({ x, y });
                const hovering = Boolean(!this.drag && this.hoverDoc && !d.closed);
                // With the pointer as a would-be next point: a curvature path already bends as that click would make it.
                const next = hovering ? (isCurvature(d) ? this.drafted(this.hoverDoc) : [...this.drafted(), corner(this.hoverDoc.x, this.hoverDoc.y)]) : null;
                const pts = next ? next.slice(0, -1) : this.drafted();
                ctx.save();
                // The path as it will look, then the segment the next click would add.
                paint(ctx, { ...this.style(), points: pts, closed: d.closed }, f, view.ppp);
                if (next) {
                    const a = next[next.length - 2], b = next[next.length - 1];
                    const s = f(a.x, a.y), c1 = f(a.outX, a.outY), c2 = f(b.inX, b.inY), e = f(b.x, b.y);
                    ctx.beginPath();
                    ctx.moveTo(s.x, s.y);
                    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, e.x, e.y);
                    ctx.setLineDash([4, 3]);
                    ctx.lineWidth = 1;
                    ctx.strokeStyle = accent;
                    ctx.stroke();
                    ctx.setLineDash([]);
                }
                const handles = isCurvature(d) ? new Set() : new Set([pts.length - 1]);
                this.drawSkeleton(ctx, pts, d.closed, f, accent, { handlesOf: handles, selected: null, first: true, curvature: isCurvature(d) });
                ctx.restore();
                return;
            }
            const edit = this.live || this.editable();
            if (!edit) return;
            const f = this.screenOf(edit), v = edit.version;
            ctx.save();
            if (this.live) paint(ctx, v, f, view.ppp * edit.t.width / Math.max(1, board.doc.entry(edit.record.id).image.width));
            this.drawSkeleton(ctx, v.points, v.closed, f, accent, { handlesOf: this.handlesShown(v) ? null : new Set(), selected: this.selected, curvature: isCurvature(v) });
            ctx.restore();
        }

        // The path's outline, its points (the selected one filled; on a curvature path smooth points are round and
        // corners square) and handles.
        drawSkeleton(ctx, pts, closed, f, accent, { handlesOf = null, selected = null, first = false, curvature = false } = {}) {
            ctx.beginPath();
            trace(ctx, pts, closed && pts.length > 1, f);
            ctx.lineWidth = 1;
            ctx.strokeStyle = accent;
            ctx.stroke();
            pts.forEach((p, i) => {
                if (handlesOf && !handlesOf.has(i)) return;
                const a = f(p.x, p.y);
                for (const [x, y, on] of [[p.inX, p.inY, hasIn(p)], [p.outX, p.outY, hasOut(p)]]) {
                    if (!on) continue;
                    const h = f(x, y);
                    ctx.beginPath();
                    ctx.moveTo(a.x, a.y);
                    ctx.lineTo(h.x, h.y);
                    ctx.strokeStyle = accent;
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.arc(h.x, h.y, 3, 0, Math.PI * 2);
                    ctx.fillStyle = '#ffffff';
                    ctx.fill();
                    ctx.stroke();
                }
            });
            pts.forEach((p, i) => {
                const a = f(p.x, p.y), size = first && i === 0 ? 8 : 6;
                ctx.fillStyle = i === selected ? accent : '#ffffff';
                ctx.strokeStyle = accent;
                if (curvature && !p.corner) {
                    ctx.beginPath();
                    ctx.arc(a.x, a.y, size / 2, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                } else {
                    ctx.fillRect(a.x - size / 2, a.y - size / 2, size, size);
                    ctx.strokeRect(a.x - size / 2, a.y - size / 2, size, size);
                }
            });
        }
    }

    CB.Pen = { render, shows, bounds, smooth };
    CB.registerTool({ id: 'pen', title: 'Pen (P) · Tab switches Curvature and Pen', key: 'KeyP', icon: 'pen', create: (board) => new PenTool(board) });
})();
