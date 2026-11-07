'use strict';
// The Move / Transform tool's geometry, ported from upstream Document/LayerTransform.swift (TransformDrag,
// TransformSnap), Document/Crop.swift and Document/Guides.swift (snapping) and Rendering/TransformOverlay.swift
// (handles and hit testing). Transforms here are the plain objects of CB.Transform.read.

(function () {
    const CB = (window.CB = window.CB || {});
    const { Transform } = CB;

    const SNAP_DISTANCE = 10; // screen points
    const HANDLE_RADIUS = 10; // screen points
    const ROTATION_STICK = 28; // screen points beyond the top-centre handle
    const HANDLES = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];

    const roundHalfAway = (v) => Math.sign(v) * Math.round(Math.abs(v));

    function point(t, ux, uy) {
        const r = Transform.radians(t), c = Transform.center(t);
        const x = (ux - 0.5) * t.width, y = (uy - 0.5) * t.height;
        return { x: c.x + x * Math.cos(r) - y * Math.sin(r), y: c.y + x * Math.sin(r) + y * Math.cos(r) };
    }

    function contains(t, p) {
        const r = Transform.radians(t), c = Transform.center(t);
        const x = p.x - c.x, y = p.y - c.y;
        return Math.abs(x * Math.cos(r) + y * Math.sin(r)) <= t.width / 2 && Math.abs(-x * Math.sin(r) + y * Math.cos(r)) <= t.height / 2;
    }

    function corners(t) {
        return [point(t, 0, 0), point(t, 1, 0), point(t, 1, 1), point(t, 0, 1)];
    }

    function isValid(t) {
        return [t.x, t.y, t.width, t.height, t.rotation].every(Number.isFinite)
            && t.width >= 1 && t.width <= 300000 && t.height >= 1 && t.height <= 300000
            && Math.abs(t.x) <= 1000000 && Math.abs(t.y) <= 1000000;
    }

    // Whole pixels and whole degrees: what dragging leaves behind.
    function rounded(t) {
        return {
            ...t,
            x: roundHalfAway(t.x), y: roundHalfAway(t.y),
            width: Math.max(1, roundHalfAway(t.width)), height: Math.max(1, roundHalfAway(t.height)),
            rotation: roundHalfAway(t.rotation),
        };
    }

    // TransformDrag.updated
    function updated(drag, p, { lockRatio, shift, option }) {
        const original = drag.original;
        const result = { ...original };
        if (drag.mode === 'move') {
            let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
            if (shift) {
                if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
                else dx = 0;
            }
            result.x += dx;
            result.y += dy;
        } else if (drag.mode === 'rotate') {
            const c = Transform.center(original);
            const delta = Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(drag.start.y - c.y, drag.start.x - c.x);
            result.rotation += (delta * 180) / Math.PI;
            if (shift) result.rotation = roundHalfAway(result.rotation / 15) * 15;
        } else if (drag.mode === 'resize') {
            const [hx, hy] = HANDLES[drag.index];
            const anchorUnit = option ? [0.5, 0.5] : [1 - hx, 1 - hy];
            const anchor = point(original, anchorUnit[0], anchorUnit[1]);
            const initial = point(original, hx, hy);
            const dx = initial.x + p.x - drag.start.x - anchor.x;
            const dy = initial.y + p.y - drag.start.y - anchor.y;
            const span = option ? 2 : 1;
            const r = Transform.radians(original);
            const localX = (dx * Math.cos(r) + dy * Math.sin(r)) * span;
            const localY = (-dx * Math.sin(r) + dy * Math.cos(r)) * span;
            const sx = hx * 2 - 1, sy = hy * 2 - 1;
            const rawWidth = sx === 0 ? original.width : localX * sx;
            const rawHeight = sy === 0 ? original.height : localY * sy;
            const mirroredX = rawWidth < 0, mirroredY = rawHeight < 0;
            let width = Math.max(1, Math.abs(rawWidth));
            let height = Math.max(1, Math.abs(rawHeight));
            if (lockRatio !== shift) {
                let factor;
                if (sx === 0) factor = height / original.height;
                else if (sy === 0) factor = width / original.width;
                else {
                    factor = Math.max(1 / Math.min(original.width, original.height),
                        (localX * sx * original.width + localY * sy * original.height)
                        / (original.width * original.width + original.height * original.height));
                }
                width = original.width * factor;
                height = original.height * factor;
            }
            result.width = width;
            result.height = height;
            if (mirroredX) result.flipX = !result.flipX;
            if (mirroredY) result.flipY = !result.flipY;
            const offsetX = (0.5 - anchorUnit[0]) * width * (mirroredX ? -1 : 1);
            const offsetY = (0.5 - anchorUnit[1]) * height * (mirroredY ? -1 : 1);
            const cx = anchor.x + offsetX * Math.cos(r) - offsetY * Math.sin(r);
            const cy = anchor.y + offsetX * Math.sin(r) + offsetY * Math.cos(r);
            result.x = cx - width / 2;
            result.y = cy - height / 2;
        }
        return isValid(result) ? result : original;
    }

    // Handles in screen space (TransformOverlayGeometry); `toScreen` maps document points to CSS pixels.
    function geometry(t, toScreen) {
        const handles = HANDLES.map(([ux, uy]) => toScreen(point(t, ux, uy)));
        const r = Transform.radians(t);
        const rotation = { x: handles[1].x + Math.sin(r) * ROTATION_STICK, y: handles[1].y - Math.cos(r) * ROTATION_STICK };
        return { handles, rotation };
    }

    function hit(geo, p) {
        const near = (o) => Math.hypot(p.x - o.x, p.y - o.y) <= HANDLE_RADIUS;
        if (geo.rotation && near(geo.rotation)) return { mode: 'rotate' };
        const index = geo.handles.findIndex(near);
        if (index >= 0) return { mode: 'resize', index };
        for (const [start, end, handle] of [[0, 2, 1], [2, 4, 3], [4, 6, 5], [6, 0, 7]]) {
            const a = geo.handles[start], b = geo.handles[end];
            const dx = b.x - a.x, dy = b.y - a.y, lengthSquared = dx * dx + dy * dy;
            if (!lengthSquared) continue;
            const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
            if (t >= 0 && t <= 1 && Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) <= HANDLE_RADIUS) return { mode: 'resize', index: handle };
        }
        return null;
    }

    // A CSS cursor for a resize handle at the box's current angle.
    function resizeCursor(geo, index) {
        const angle = Math.atan2(geo.handles[2].y - geo.handles[0].y, geo.handles[2].x - geo.handles[0].x);
        const offsets = [Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4, 0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4, 0];
        const direction = ((roundHalfAway((angle + offsets[index]) / (Math.PI / 4)) % 4) + 4) % 4;
        return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][direction];
    }

    // alignmentSnapTargets: canvas edges (and centre), other layers' bounding edges (and centres), visible guides.
    function snapTargets({ width, height, layers, guides, excluding, includeCenters }) {
        const xs = [0, width], ys = [0, height];
        if (includeCenters) { xs.push(width / 2); ys.push(height / 2); }
        for (const t of layers) {
            if (excluding && excluding(t)) continue;
            const cs = corners(t);
            const minX = Math.min(...cs.map((c) => c.x)), maxX = Math.max(...cs.map((c) => c.x));
            const minY = Math.min(...cs.map((c) => c.y)), maxY = Math.max(...cs.map((c) => c.y));
            xs.push(roundHalfAway(minX), roundHalfAway(maxX));
            ys.push(roundHalfAway(minY), roundHalfAway(maxY));
            if (includeCenters) { xs.push(roundHalfAway((minX + maxX) / 2)); ys.push(roundHalfAway((minY + maxY) / 2)); }
        }
        for (const g of guides || []) (g.axis === 'vertical' ? xs : ys).push(g.position);
        return { xs, ys };
    }

    function shiftTo(values, targets, tolerance) {
        let best = null;
        for (const v of values) for (const target of targets) {
            const move = target - v;
            if (Math.abs(move) > tolerance) continue;
            if (best && Math.abs(best.move) <= Math.abs(move)) continue;
            best = { move, target };
        }
        return best || { move: 0, target: null };
    }

    // snappedMove: the draft nudged so its bounding box's left/centre/right (and top/middle/bottom) meet a target.
    function snappedMove(draft, targets, tolerance) {
        const cs = corners(draft);
        const minX = Math.min(...cs.map((c) => c.x)), maxX = Math.max(...cs.map((c) => c.x));
        const minY = Math.min(...cs.map((c) => c.y)), maxY = Math.max(...cs.map((c) => c.y));
        const h = shiftTo([minX, (minX + maxX) / 2, maxX], targets.xs, tolerance);
        const v = shiftTo([minY, (minY + maxY) / 2, maxY], targets.ys, tolerance);
        const guides = { xs: h.target === null ? [] : [h.target], ys: v.target === null ? [] : [v.target] };
        if (!h.move && !v.move) return { draft, guides };
        return { draft: { ...draft, x: draft.x + h.move, y: draft.y + v.move }, guides };
    }

    // snappedResizePoint: the pointer nudged so the edges a handle moves land on targets (upright layers only).
    function snappedResizePoint(p, drag, { proportional, targets, tolerance, update }) {
        if (drag.mode !== 'resize' || Transform.radians(drag.original) !== 0) return { point: p, guides: { xs: [], ys: [] } };
        const [hx, hy] = HANDLES[drag.index];
        const grab = point(drag.original, hx, hy);
        const at = { x: grab.x + p.x - drag.start.x, y: grab.y + p.y - drag.start.y };
        const edge = (t, horizontal) => horizontal
            ? (Math.abs(t.x - at.x) <= Math.abs(t.x + t.width - at.x) ? t.x : t.x + t.width)
            : (Math.abs(t.y - at.y) <= Math.abs(t.y + t.height - at.y) ? t.y : t.y + t.height);
        const nearest = (value, lines) => {
            let best = null;
            for (const l of lines) if (Math.abs(l - value) <= tolerance && (best === null || Math.abs(l - value) < Math.abs(best - value))) best = l;
            return best;
        };
        const draft = update(p);
        let snaps = [];
        if (hx !== 0.5) { const x = nearest(edge(draft, true), targets.xs); if (x !== null) snaps.push({ horizontal: true, target: x }); }
        if (hy !== 0.5) { const y = nearest(edge(draft, false), targets.ys); if (y !== null) snaps.push({ horizontal: false, target: y }); }
        if (proportional && snaps.length === 2) {
            snaps = [snaps.reduce((a, b) => (Math.abs(a.target - edge(draft, a.horizontal)) <= Math.abs(b.target - edge(draft, b.horizontal)) ? a : b))];
        }
        const result = { ...p };
        for (const snap of snaps) {
            const before = edge(update(result), snap.horizontal);
            const nudged = { ...result };
            if (snap.horizontal) nudged.x += 1;
            else nudged.y += 1;
            const perPixel = edge(update(nudged), snap.horizontal) - before;
            if (Math.abs(perPixel) <= 0.01) continue;
            const shift = (snap.target - before) / perPixel;
            if (snap.horizontal) result.x += shift;
            else result.y += shift;
        }
        return {
            point: result,
            guides: { xs: snaps.filter((s) => s.horizontal).map((s) => s.target), ys: snaps.filter((s) => !s.horizontal).map((s) => s.target) },
        };
    }

    // snappedPoint: a shape corner moved onto the nearest target within `tolerance`, each axis on its own.
    function snappedPoint(p, targets, tolerance) {
        const nearest = (value, lines) => {
            let best = null;
            for (const l of lines) if (Math.abs(l - value) <= tolerance && (best === null || Math.abs(l - value) < Math.abs(best - value))) best = l;
            return best;
        };
        const x = nearest(p.x, targets.xs), y = nearest(p.y, targets.ys);
        return { point: { x: x === null ? p.x : x, y: y === null ? p.y : y }, guides: { xs: x === null ? [] : [x], ys: y === null ? [] : [y] } };
    }

    // LayerTransform.placing: the transform that places the unit square as the affine `map` does (shear dropped).
    function placing(self, map) {
        const sign = self.flipX ? -1 : 1;
        const angle = Math.atan2(map.b * sign, map.a * sign);
        const along = -map.c * Math.sin(angle) + map.d * Math.cos(angle);
        const middle = CB.Affine.apply(map, 0.5, 0.5);
        const width = Math.hypot(map.a, map.b), height = Math.abs(along);
        const degrees = (angle * 180) / Math.PI;
        return {
            ...self, width, height,
            rotation: degrees + roundHalfAway((self.rotation - degrees) / 360) * 360,
            flipY: along < 0,
            x: middle.x - width / 2, y: middle.y - height / 2,
        };
    }

    // LayerTransform.following: a placement (a mask placed apart) carried along as its layer goes from `old` to `next`.
    function following(self, old, next) {
        const same = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.rotation === b.rotation && a.flipX === b.flipX && a.flipY === b.flipY;
        if (same(old, next)) return self;
        if (old.width === next.width && old.height === next.height && old.rotation === next.rotation && old.flipX === next.flipX && old.flipY === next.flipY) {
            return { ...self, x: self.x + next.x - old.x, y: self.y + next.y - old.y };
        }
        const unit = (t) => Transform.pixelToDocument(t, 1, 1);
        const map = CB.Affine.multiply(unit(next), CB.Affine.multiply(CB.Affine.invert(unit(old)), unit(self)));
        return placing(self, map);
    }

    // Handles for a distortion (TransformOverlay.swift:17-24): the four corners and the midpoints between them, taken in
    // view space; no rotation handle.
    function cornerGeometry(cs, toScreen) {
        const v = cs.map(toScreen);
        const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        return { handles: [v[0], mid(v[0], v[1]), v[1], mid(v[1], v[2]), v[2], mid(v[2], v[3]), v[3], mid(v[3], v[0])], rotation: null };
    }

    // TransformDrag.corners(to:shift:) (LayerTransform.swift:136-151): a corner handle moves its corner, an edge handle
    // both corners of that edge, the body the whole shape; Shift keeps the drag on one axis. Not rounded, not snapped.
    function draggedCorners(drag, p, shift) {
        if (!drag.originalCorners) return null;
        let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
        if (shift) {
            if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
            else dx = 0;
        }
        let moved;
        if (drag.mode === 'distort') moved = drag.index % 2 === 0 ? [drag.index / 2] : [(drag.index - 1) / 2, ((drag.index - 1) / 2 + 1) % 4];
        else if (drag.mode === 'move') moved = [0, 1, 2, 3];
        else return null;
        const result = drag.originalCorners.map((c) => ({ ...c }));
        for (const corner of moved) { result[corner].x += dx; result[corner].y += dy; }
        return result;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Free distortion (Document/Distort.swift DistortWarp; geometry.md 7.1-7.2). Corners are TL, TR, BR, BL.

    // The perspective map of the unit square (u right, v down) onto `c`, row-major: [X, Y, W] = M [u, v, 1].
    function homography(c) {
        const sx = c[0].x - c[1].x + c[2].x - c[3].x, sy = c[0].y - c[1].y + c[2].y - c[3].y;
        let g = 0, h = 0;
        if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
            const dx1 = c[1].x - c[2].x, dx2 = c[3].x - c[2].x, dy1 = c[1].y - c[2].y, dy2 = c[3].y - c[2].y;
            const den = dx1 * dy2 - dx2 * dy1;
            if (Math.abs(den) > 1e-12) {
                g = (sx * dy2 - dx2 * sy) / den;
                h = (dx1 * sy - sx * dy1) / den;
            }
        }
        return [c[1].x - c[0].x + g * c[1].x, c[3].x - c[0].x + h * c[3].x, c[0].x,
            c[1].y - c[0].y + g * c[1].y, c[3].y - c[0].y + h * c[3].y, c[0].y, g, h, 1];
    }

    function project(M, u, v) {
        const w = M[6] * u + M[7] * v + M[8];
        return { x: (M[0] * u + M[1] * v + M[2]) / w, y: (M[3] * u + M[4] * v + M[5]) / w };
    }

    const area = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

    // Four finite corners whose two halves both have area (Distort.swift:16-23).
    function isUsable(c) {
        if (!c || c.length !== 4 || !c.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) <= 1000000 && Math.abs(p.y) <= 1000000)) return false;
        return Math.abs(area(c[0], c[1], c[2])) > 0.01 && Math.abs(area(c[0], c[2], c[3])) > 0.01;
    }

    // Convex and wound one way, either way (Distort.swift:29-38).
    function isConvex(c) {
        if (!isUsable(c)) return false;
        let sign = 0;
        for (let i = 0; i < 4; i++) {
            const a = c[i], b = c[(i + 1) % 4], d = c[(i + 2) % 4];
            const cross = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x);
            if (Math.abs(cross) <= 0.01) return false;
            if (sign === 0) sign = cross < 0 ? -1 : 1;
            else if ((cross < 0) !== (sign < 0)) return false;
        }
        return true;
    }

    // Where the image's own corners land on the shape: a flipped layer's pixels go to the opposite corners.
    function imageCorners(c, flipX, flipY) {
        const corner = (x, y) => {
            const u = flipX ? 1 - x : x, v = flipY ? 1 - y : y;
            return c[[0, 1, 3, 2][v * 2 + u]];
        };
        return [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
    }

    // DistortWarp.carried: `placement`'s corners taken through `transform`'s unit square into the perspective of `Q`
    // (flips ignored, as corners(of:) ignores them).
    function carried(placement, transform, Q) {
        const M = homography(Q), r = Transform.radians(transform), c = Transform.center(transform);
        return corners(placement).map((p) => {
            const dx = p.x - c.x, dy = p.y - c.y;
            const x = dx * Math.cos(r) + dy * Math.sin(r), y = -dx * Math.sin(r) + dy * Math.cos(r);
            return project(M, x / transform.width + 0.5, y / transform.height + 0.5);
        });
    }

    // The affine map taking three points to three points (Distort.swift:41-53).
    function affine3(s, t) {
        const u = { x: s[1].x - s[0].x, y: s[1].y - s[0].y }, v = { x: s[2].x - s[0].x, y: s[2].y - s[0].y };
        const uu = { x: t[1].x - t[0].x, y: t[1].y - t[0].y }, vv = { x: t[2].x - t[0].x, y: t[2].y - t[0].y };
        const det = u.x * v.y - v.x * u.y;
        if (Math.abs(det) <= 1e-9) return null;
        const a = (uu.x * v.y - vv.x * u.y) / det, c = (vv.x * u.x - uu.x * v.x) / det;
        const b = (uu.y * v.y - vv.y * u.y) / det, d = (vv.y * u.x - uu.y * v.x) / det;
        return { a, b, c, d, e: t[0].x - (a * s[0].x + c * s[0].y), f: t[0].y - (b * s[0].x + d * s[0].y) };
    }

    // One image triangle drawn onto a canvas triangle; `grow` widens the clip about its centroid to hide seams.
    function drawTriangle(ctx, image, s, d, grow) {
        const m = affine3(s, d);
        if (!m) return;
        const cx = (d[0].x + d[1].x + d[2].x) / 3, cy = (d[0].y + d[1].y + d[2].y) / 3;
        ctx.save();
        ctx.beginPath();
        d.forEach((p, i) => {
            const dx = p.x - cx, dy = p.y - cy, length = Math.hypot(dx, dy) || 1;
            const q = { x: p.x + (dx / length) * grow, y: p.y + (dy / length) * grow };
            if (i) ctx.lineTo(q.x, q.y);
            else ctx.moveTo(q.x, q.y);
        });
        ctx.closePath();
        ctx.clip();
        ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
        ctx.drawImage(image, 0, 0);
        ctx.restore();
    }

    // The preview of DistortWarp.warp: `image`, shown through `transform`, drawn so its corners land on `Q`, over the
    // shape's whole-pixel bounds at most `limit` px on the long side. Convex shapes are subdivided into small triangles
    // (a piecewise-affine perspective), folded ones drawn as upstream's two nearest-sampled triangles (warpFolded).
    // Returns { canvas, toDocument, transform } (an axis-aligned placement of the bounds) or null.
    function warp(image, transform, Q, { limit = 2048 } = {}) {
        if (!isUsable(Q)) return null;
        const xs = Q.map((p) => p.x), ys = Q.map((p) => p.y);
        const x0 = Math.floor(Math.min(...xs)), y0 = Math.floor(Math.min(...ys));
        const w = Math.ceil(Math.max(...xs)) - x0, h = Math.ceil(Math.max(...ys)) - y0;
        if (w < 1 || h < 1 || w > 30000 || h > 30000) return null;
        const k = Math.min(1, limit / Math.max(w, h));
        const ow = Math.max(1, Math.round(w * k)), oh = Math.max(1, Math.round(h * k));
        const sx = ow / w, sy = oh / h;
        const canvas = new OffscreenCanvas(ow, oh);
        const ctx = canvas.getContext('2d');
        const out = (p) => ({ x: (p.x - x0) * sx, y: (p.y - y0) * sy });
        const W = image.width, H = image.height;
        if (isConvex(Q)) {
            const M = homography(Q);
            const v = Q.map(out);
            const edge = Math.max(...v.map((p, i) => Math.hypot(v[(i + 1) % 4].x - p.x, v[(i + 1) % 4].y - p.y)));
            const n = Math.min(32, Math.max(2, Math.ceil(edge / 24)));
            const src = (u, t) => ({ x: (transform.flipX ? 1 - u : u) * W, y: (transform.flipY ? 1 - t : t) * H });
            const grid = [];
            for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) grid.push(out(project(M, i / n, j / n)));
            ctx.imageSmoothingEnabled = transform.sampling !== 'Nearest';
            ctx.imageSmoothingQuality = 'high';
            for (let j = 0; j < n; j++) {
                for (let i = 0; i < n; i++) {
                    const p00 = grid[j * (n + 1) + i], p10 = grid[j * (n + 1) + i + 1];
                    const p01 = grid[(j + 1) * (n + 1) + i], p11 = grid[(j + 1) * (n + 1) + i + 1];
                    const s00 = src(i / n, j / n), s10 = src((i + 1) / n, j / n), s01 = src(i / n, (j + 1) / n), s11 = src((i + 1) / n, (j + 1) / n);
                    drawTriangle(ctx, image, [s00, s10, s11], [p00, p10, p11], 0.5);
                    drawTriangle(ctx, image, [s00, s11, s01], [p00, p11, p01], 0.5);
                }
            }
        } else {
            // warpFolded (Distort.swift:125-156): image (TL, TR, BR) and (TL, BR, BL) onto the matching shape corners.
            const t = imageCorners(Q, transform.flipX, transform.flipY).map(out);
            ctx.imageSmoothingEnabled = false;
            const halves = [[[{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }], [t[0], t[1], t[2]]],
                [[{ x: 0, y: 0 }, { x: W, y: H }, { x: 0, y: H }], [t[0], t[2], t[3]]]];
            for (const [s, d] of halves) drawTriangle(ctx, image, s, d, 0);
        }
        return {
            canvas,
            toDocument: { a: 1 / sx, b: 0, c: 0, d: 1 / sy, e: x0, f: y0 },
            transform: { x: x0, y: y0, width: w, height: h, rotation: 0, flipX: false, flipY: false, sampling: transform.sampling },
        };
    }

    CB.TransformTool = {
        placing, following,
        SNAP_DISTANCE, HANDLES, point, contains, corners, isValid, rounded, updated, geometry, hit, resizeCursor,
        snapTargets, snappedMove, snappedResizePoint, snappedPoint, cornerGeometry, draggedCorners,
    };
    CB.Distort = { homography, project, isUsable, isConvex, imageCorners, carried, affine3, warp };
})();

// Transform edits on the board, mirroring EditorSession's TransformEdit (Document/EditorSession.swift:445-579,
// Document/Distort.swift:262-406, Document/LayerTransform.swift:100-124; geometry.md sections 4 and 6): one edit at a
// time, opened by a handle drag, a nudge or a Move-bar field (applied when the gesture ends) or by ⌘T and any distortion
// (waiting for Apply or Cancel). Placement-only commits are written here; distortions are resampled by
// compositor-engine. Also the Move bar (UI/TransformInspector.swift) and the snap targets (Document/Guides.swift).
// Mixed into the Board.

(function () {
    const CB = (window.CB = window.CB || {});
    const { Transform, TransformTool, Distort, Shapes } = CB;
    const KEYS = ['x', 'y', 'width', 'height', 'rotation', 'flipX', 'flipY'];
    const samePlace = (a, b) => KEYS.every((k) => a[k] === b[k]);
    const roundHalfAway = (v) => Math.sign(v) * Math.round(Math.abs(v));
    // Swift's Double(String) for the Move bar's fields: no spaces, no grouping (geometry.md 8.3).
    const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
    const parse = (text) => (NUMBER.test(text) && Number.isFinite(Number(text)) ? Number(text) : null);

    // %.2f rounds exact binary ties to even (1.125 -> "1.12"), toFixed rounds them up (geometry.md 8.6).
    function toFixed2HalfEven(v) {
        if (Number.isInteger(v * 8) && !Number.isInteger(v * 4)) {
            const n = Math.floor(v * 100);
            return ((n % 2 === 0 ? n : n + 1) / 100).toFixed(2);
        }
        return v.toFixed(2);
    }

    // TransformValueField.formatted (TransformInspector.swift:141-144): whole numbers bare, two decimals otherwise.
    function formatted(v) {
        if (Math.abs(v - roundHalfAway(v)) < 0.005) return String(roundHalfAway(v) || 0);
        return toFixed2HalfEven(v);
    }

    // The white arrow of a distortion (EditorCanvas.swift:200-201).
    const DISTORT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M1 1v15.5l4-3.8 2.6 6 2.4-1-2.5-5.8H13z" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/></svg>';
    const DISTORT_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(DISTORT_SVG)}") 1 1, default`;

    const TransformEdits = {
        layerTransform(record) {
            return Transform.read(record.transform, [this.doc.width, this.doc.height]);
        },

        // LayerMask's maskTransform: its own placement, else the layer's.
        maskTransformOf(record) {
            return Transform.read(record.maskPlacement || record.transform, [this.doc.width, this.doc.height]);
        },

        // ---------------------------------------------------------------------------------------------------------------
        // What a transform moves (EditorSession.swift:356-386)

        transformsAsGroup() {
            const a = this.activeLayer();
            return this.selectedIDs.size > 1 || (this.selectedIDs.size === 1 && Boolean(a && a.isGroup));
        },

        // The visible pixel layers selected, or inside a selected folder (at most 64 levels up), bottom to top.
        groupMembers() {
            if (!this.transformsAsGroup()) return [];
            const byID = new Map(this.doc.layers.map((l) => [l.id, l]));
            return this.doc.layers.filter((layer) => {
                if (!this.doc.entry(layer.id).image || layer.isGroup || !this.effectivelyVisible(layer)) return false;
                let id = layer.id;
                for (let i = 0; i < 64; i++) {
                    if (!id) return false;
                    if (this.selectedIDs.has(id)) return true;
                    const record = byID.get(id);
                    id = record ? record.parentID || null : null;
                }
                return false;
            });
        },

        // The upright box around the members' corners, sides at least 1.
        groupBox(members = this.groupMembers()) {
            const points = members.flatMap((m) => TransformTool.corners(this.layerTransform(m)));
            if (!points.length) return null;
            const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
            const x = Math.min(...xs), y = Math.min(...ys);
            return { x, y, width: Math.max(1, Math.max(...xs) - x), height: Math.max(1, Math.max(...ys) - y), rotation: 0, flipX: false, flipY: false, sampling: 'High quality' };
        },

        // canTransform without canEditLayers: there is something to transform.
        transformTargetsReady() {
            if (!this.doc.manifest) return false;
            if (this.transformsAsGroup()) return this.groupMembers().length > 0;
            const a = this.activeLayer();
            return Boolean(a && this.doc.entry(a.id).image && !a.isGroup && this.effectivelyVisible(a));
        },

        canTransform() {
            return this.canEditLayers() && this.transformTargetsReady() && !this.lockRefusal(this.transformLockTargets());
        },

        // The layers a transform would move, for the layer locks: the group's members, or the active layer.
        transformLockTargets() {
            return this.transformsAsGroup() ? this.groupMembers() : [this.activeLayer()];
        },

        // An unlinked mask selected transforms on its own (transformTargetsMask).
        transformTargetsMask() {
            if (this.transformEdit) return this.transformEdit.mask;
            const a = this.activeLayer();
            return Boolean(this.isMaskSelected && a && a.maskFile && a.maskLinked === false);
        },

        // FloatingSelection.canTransformSelection: ⌘T lifts the selected pixels instead.
        canTransformSelection() {
            const a = this.activeLayer();
            return !this.transformEdit && this.canEditLayers() && !this.isMaskSelected && this.hasPixelsSelected() && Boolean(a && this.doc.entry(a.id).image) && !this.isLocked(a);
        },

        canTransformCommand() {
            return this.canTransform() || this.canTransformSelection();
        },

        // Layer › Transform Layer / Transform Selection (⌘T): FloatingSelection.transformCommand.
        transformCommand() {
            if (this.canTransformSelection()) this.selectTools.beginFloating();
            else this.beginTransformEdit(true);
        },

        // ---------------------------------------------------------------------------------------------------------------
        // The edit (geometry.md section 6)

        // beginTransform: a crop frame goes; the Move tool takes over without selectTool's side effects. `duringDrag`:
        // opened by a drag already holding the canvas (the copies of an Option-drag). `copying`: an Option-drag, which
        // moves copies and leaves a locked original alone.
        beginTransformEdit(persistent = true, { duringDrag = false, copying = false } = {}) {
            this.cancelCrop();
            if (this.transformEdit) return false;
            if (!duringDrag && !copying && this.canEditLayers() && this.transformTargetsReady() && this.refuseLocked(this.transformLockTargets())) return false;
            if (!(duringDrag || copying ? this.transformTargetsReady() && (duringDrag || this.canEditLayers()) : this.canTransform())) return false;
            const a = this.activeLayer();
            if (this.tool !== 'move') {
                this.tool = 'move';
                this.toolChanged();
            }
            if (this.transformsAsGroup()) {
                const members = this.groupMembers(), box = this.groupBox(members);
                if (!box) return false;
                this.transformEdit = {
                    layerID: a.id, draft: box, persistent, corners: null, mask: false, fromFields: false,
                    group: { box, originals: new Map(members.map((m) => [m.id, this.layerTransform(m)])) },
                };
            } else {
                const maskAlone = Boolean(this.isMaskSelected && a.maskFile && a.maskLinked === false);
                this.transformEdit = {
                    layerID: a.id, draft: maskAlone ? this.maskTransformOf(a) : this.layerTransform(a), persistent,
                    corners: null, mask: maskAlone, group: null, fromFields: false,
                };
            }
            this.showTransformEdit();
            return true;
        },

        previewTransformEdit(value) {
            const e = this.transformEdit;
            if (!e || !TransformTool.isValid(value)) return;
            e.draft = value;
            this.showTransformEdit();
        },

        // Cmd on a handle: the corners start moving freely, and the edit waits for Apply.
        beginDistort() {
            const e = this.transformEdit;
            if (!e || e.corners || !TransformTool.isValid(e.draft)) return;
            e.persistent = true;
            e.corners = TransformTool.corners(e.draft);
            this.showTransformEdit();
        },

        // A twisted or collapsed shape is ignored: the corners stay at the last usable one.
        previewCorners(corners) {
            const e = this.transformEdit;
            if (!e || !e.corners || !Distort.isUsable(corners)) return;
            e.corners = corners;
            this.showTransformEdit();
        },

        // Arrow keys with the Move tool: their own step, unless an edit is open, which takes the nudge.
        nudgeLayer(dx, dy) {
            const open = Boolean(this.transformEdit);
            if (!open && !this.beginTransformEdit(false)) return;
            const e = this.transformEdit;
            this.previewTransformEdit({ ...e.draft, x: e.draft.x + dx, y: e.draft.y + dy });
            if (e.corners) this.previewCorners(e.corners.map((p) => ({ x: p.x + dx, y: p.y + dy })));
            if (!open) this.commitTransformEdit();
        },

        commitTransformEdit() {
            this.view.guides = { xs: [], ys: [] };
            const e = this.transformEdit;
            if (!e) return Promise.resolve();
            this.transformEdit = null;
            this.distortCache = new Map();
            if (e.corners && !e.duplicate) return this.commitDistort(e);
            this.clearTransformPreview();
            if (e.duplicate) this.finishDuplicateEdit(e);
            else if (e.mask) this.commitMaskTransform(e.layerID, e.draft);
            else if (e.group) this.commitGroupTransform(e);
            else this.commitTransform(e.layerID, e.draft, 'Transform Layer');
            this.transformEnded();
            return Promise.resolve();
        },

        cancelTransformEdit() {
            this.view.guides = { xs: [], ys: [] };
            const e = this.transformEdit;
            if (!e) return false;
            this.transformEdit = null;
            this.distortCache = new Map();
            this.clearTransformPreview();
            if (e.duplicate) {
                // The copies go and the selection is what it was (EditorSession.swift:526-537).
                this.cancelDragCopy(e.duplicate);
                this.selectedIDs = new Set(e.duplicate.selection);
                this.layerSelectionChanged();
            }
            this.transformEnded();
            return true;
        },

        transformEnded() {
            this.changed();
            this.renderOptions(true);
            this.view.cursor();
        },

        // Option-drag (beginDuplicateTransform, EditorSession.swift:466-483): what an open edit holds is applied, the
        // selected layers (folders with what is in them) are copied above the topmost original and selected, and a new
        // edit moves the copies; the copy and its move are one "Duplicate Layer(s)" step, and Cancel takes the copies
        // away again.
        async beginDuplicateTransform() {
            const primary = this.activeID(), selection = [...this.selectedIDs];
            await this.commitTransformEdit();
            if (!primary || !this.transformTargetsReady()) return false;
            // Selected roots: the selected layers without a selected folder above them.
            const roots = selection.filter((id) => !this.ancestors(this.doc.layer(id) || {}).some((f) => selection.includes(f.id)));
            const copy = await this.duplicateForDrag(primary, selection);
            if (!copy) return false;
            if (!this.beginTransformEdit(false, { duringDrag: true })) {
                this.cancelDragCopy(copy);
                this.selectedIDs = new Set(selection);
                this.layerSelectionChanged();
                return false;
            }
            this.transformEdit.duplicate = { ...copy, selection, label: roots.length > 1 ? 'Duplicate Layers' : 'Duplicate Layer' };
            return true;
        },

        // A placement change of one record: its mask's place (LayerMask.placement(movingLayer:to:)) and a live shape
        // drawn again at its new size (ShapeTool.redrawShape). Returns the pixel changes.
        placeRecord(record, old, next) {
            const pixels = [];
            const placement = this.maskPlacementAfterMove(record, old, next);
            record.transform = Transform.write(next);
            if (placement === null) delete record.maskPlacement;
            else if (placement) record.maskPlacement = Transform.write(placement);
            const entry = this.doc.entry(record.id);
            const style = this.liveShapeStyle(record);
            if (style && entry.image) {
                const image = Shapes.redrawFor(style, next, entry.image);
                if (image) {
                    // A mask following the pixel grid stays where it is while the grid changes size: it takes the
                    // layer's (new) place (ShapeTool.swift:213).
                    if (record.maskFile && entry.mask && !record.maskPlacement) record.maskPlacement = Transform.write(next);
                    pixels.push({ layerID: record.id, kind: 'image', beforeBitmap: entry.image, afterBitmap: image });
                    entry.image = image;
                    this.doc.dirtyImages.add(record.id);
                }
            }
            return pixels;
        },

        // "Transform Layers": each member follows the box (shear dropped), its mask too (EditorSession.swift:501-515).
        commitGroupTransform(e) {
            if (!TransformTool.isValid(e.draft)) return;
            this.edit('Transform Layers', () => {
                const pixels = [];
                for (const [id, original] of e.group.originals) {
                    const record = this.doc.layer(id);
                    if (!record) continue;
                    const moved = TransformTool.following(original, e.group.box, e.draft);
                    if (!TransformTool.isValid(moved)) continue;
                    pixels.push(...this.placeRecord(record, original, moved));
                }
                return pixels;
            });
        },

        // An Option-drag: the copies and their move are one "Duplicate Layer(s)" step (beginDuplicateTransform).
        finishDuplicateEdit(e) {
            const copy = e.duplicate, pixels = [...copy.pixels];
            if (e.group) {
                for (const [id, original] of e.group.originals) {
                    const record = this.doc.layer(id);
                    const moved = TransformTool.following(original, e.group.box, e.draft);
                    if (record && TransformTool.isValid(moved)) pixels.push(...this.placeRecord(record, original, moved));
                }
            } else {
                const record = this.doc.layer(e.layerID);
                if (record && TransformTool.isValid(e.draft)) pixels.push(...this.placeRecord(record, this.layerTransform(record), e.draft));
            }
            this.doc.metaDirty = true;
            this.history.push({ label: copy.label, metaBefore: copy.metaBefore, metaAfter: this.doc.snapshot(), pixels });
        },

        // Apply for a distortion: Compositor resamples the pixels (and masks) into the shape. The warped preview stays
        // until the saved layers arrive (geometry.md 7.3).
        async commitDistort(e) {
            const args = { activeLayerID: e.layerID, draft: Transform.write(e.draft), corners: e.corners.map((p) => [p.x, p.y]) };
            if (e.group) args.box = Transform.write(e.group.box);
            const label = e.mask ? 'Distort Layer Mask' : e.group ? 'Distort Layers' : 'Distort';
            let result = null;
            try {
                result = await this.engine('transform.commit', args, { label });
            } catch (error) {
                this.alert('Couldn’t paint', error.message);
            }
            this.clearTransformPreview();
            if (result && result.error) this.alert('Couldn’t paint', result.error);
            if (result) this.applyEngineState(result);
            this.transformEnded();
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Preview: renderer overrides for what the edit moves

        // Each layer the edit moves, where it goes, and the corners it is distorted to (or null).
        transformTargets(e = this.transformEdit) {
            if (!e || e.mask) return [];
            if (e.group) {
                const out = [];
                for (const [id, original] of e.group.originals) {
                    const record = this.doc.layer(id);
                    if (!record) continue;
                    const transform = TransformTool.following(original, e.group.box, e.draft);
                    let corners = e.corners ? Distort.carried(transform, e.draft, e.corners) : null;
                    if (corners && !Distort.isUsable(corners)) corners = null;
                    out.push({ record, transform, corners });
                }
                return out;
            }
            const record = this.doc.layer(e.layerID);
            return record ? [{ record, transform: e.draft, corners: e.corners }] : [];
        },

        // The lowest layer the edit draws, so the live composite caches what is under it.
        transformLiveID(e = this.transformEdit) {
            if (!e) return null;
            if (!e.group) return e.layerID;
            const order = this.drawOrder().map((l) => l.id);
            let best = null;
            for (const id of e.group.originals.keys()) if (best === null || order.indexOf(id) < order.indexOf(best)) best = id;
            return best;
        },

        showTransformEdit() {
            const r = this.renderer, e = this.transformEdit;
            this.clearTransformPreview();
            if (e) {
                const set = (id, o) => { r.overrides.set(id, o); this.transformPreviewIDs.push(id); };
                if (e.mask) set(e.layerID, e.corners ? this.maskDistortOverride(e) || { maskTransform: e.draft } : { maskTransform: e.draft });
                for (const { record, transform, corners } of this.transformTargets(e)) {
                    set(record.id, (corners && this.distortOverride(record, transform, corners)) || this.affineOverride(record, transform));
                }
            }
            this.liveChanged();
            this.view.drawOverlay();
            this.refreshOptionValues();
        },

        clearTransformPreview() {
            for (const id of this.transformPreviewIDs || []) this.renderer.overrides.delete(id);
            this.transformPreviewIDs = [];
        },

        // A layer at `t`: its mask where LayerMask.editedPlacement puts it, and a rounded rectangle drawn at the size it
        // is being dragged to (ShapeTool.shapeTransformPreview, at most 2048 px, its radius scaled with it); an outlined
        // shape too, its outline scaled with it.
        affineOverride(record, t) {
            const o = { transform: t };
            const placement = this.maskPlacementAfterMove(record, this.layerTransform(record), t);
            if (placement) o.maskTransform = placement;
            else if (placement === null && record.maskPlacement) o.maskTransform = t;
            const style = this.liveShapeStyle(record), image = this.doc.entry(record.id).image;
            if (style && image && ((style.kind === 'Rectangle' && style.cornerRadius > 0) || Shapes.outlined(style.paint))
                && (Math.abs(t.width - image.width) >= 0.5 || Math.abs(t.height - image.height) >= 0.5) && t.width >= 1 && t.height >= 1) {
                const factor = Math.min(1, 2048 / Math.max(t.width, t.height));
                const w = Math.max(1, roundHalfAway(t.width * factor)), h = Math.max(1, roundHalfAway(t.height * factor));
                this.shapePreviews = this.shapePreviews || new Map();
                const cached = this.shapePreviews.get(record.id);
                let canvas = cached && cached.w === w && cached.h === h ? cached.canvas : null;
                if (!canvas) {
                    const scaled = { ...style, cornerRadius: (style.cornerRadius || 0) * factor };
                    if (style.strokeWidth) scaled.strokeWidth = style.strokeWidth * factor;
                    canvas = Shapes.shapeImage(scaled, w, h);
                    this.shapePreviews.set(record.id, { w, h, canvas });
                }
                o.canvas = canvas;
                o.toDocument = Transform.pixelToDocument(t, w, h);
            }
            return o;
        },

        // distortPreview (Distort.swift:315-346): the pixels warped into the shape, and the mask warped with them (linked,
        // in its layer's grid), taking the same perspective over its own bounds (linked, placed apart, convex), or
        // staying where it is on the document.
        distortOverride(record, t, Q) {
            const entry = this.doc.entry(record.id);
            if (!entry.image) return null;
            this.distortCache = this.distortCache || new Map();
            const key = JSON.stringify([Q, t, record.maskPlacement || null, record.maskLinked !== false, record.effects || null]);
            const cached = this.distortCache.get(record.id);
            if (cached && cached.key === key && cached.image === entry.image) return cached.override;
            // Layer effects are warped along so they stay visible during the drag: the effects image (the pixels through
            // the mask with the effects around them), its grown rectangle carried through the same perspective.
            const fx = CB.Effects && CB.Effects.visible(record.effects);
            const made = fx && CB.Effects.isValid(fx) && CB.Effects.effectsImage(entry.image, entry.mask, record, t, [this.doc.width, this.doc.height]);
            if (made) {
                const shaped = Distort.warp(made.canvas, made.transform, Distort.carried(made.transform, t, Q));
                if (shaped) {
                    const fo = { canvas: shaped.canvas, toDocument: shaped.toDocument, transform: shaped.transform, noMask: true };
                    this.distortCache.set(record.id, { key, image: entry.image, override: fo });
                    return fo;
                }
            }
            const warped = Distort.warp(entry.image, t, Q);
            if (!warped) return null;
            const o = { canvas: warped.canvas, toDocument: warped.toDocument, transform: warped.transform };
            const mask = entry.mask;
            if (mask && record.maskFile) {
                const size = [this.doc.width, this.doc.height];
                const placed = record.maskPlacement && !CB.Render.samePlacement(record.maskPlacement, record.transform);
                const linked = record.maskLinked !== false;
                const background = CB.Render.maskBackground(mask);
                let done = false;
                if (linked && !placed) {
                    const m = Distort.warp(mask.alpha, t, Q);
                    if (m) { o.mask = { canvas: m.canvas, toDocument: m.toDocument, background }; done = true; }
                } else if (linked && placed) {
                    const placement = TransformTool.following(Transform.read(record.maskPlacement, size), this.layerTransform(record), t);
                    const corners = Distort.carried(placement, t, Q);
                    if (Distort.isConvex(corners)) {
                        const m = this.warpedMask(mask, placement, corners, background);
                        if (m) { o.mask = m; done = true; }
                    }
                }
                if (!done) o.maskTransform = record.maskPlacement ? Transform.read(record.maskPlacement, size) : this.layerTransform(record);
            }
            this.distortCache.set(record.id, { key, image: entry.image, override: o });
            return o;
        },

        // An unlinked mask distorted on its own: warped over the shape's bounds, its background tone around the shape.
        maskDistortOverride(e) {
            const record = this.doc.layer(e.layerID), mask = record && this.doc.entry(record.id).mask;
            if (!mask) return null;
            const m = this.warpedMask(mask, e.draft, e.corners, CB.Render.maskBackground(mask));
            return m ? { mask: m } : null;
        },

        // DistortWarp.warpMask's preview: the mask (as alpha) warped, its background outside the shape.
        warpedMask(mask, t, Q, background) {
            const m = Distort.warp(mask.alpha, t, Q);
            if (!m) return null;
            if (background) {
                const ctx = m.canvas.getContext('2d');
                ctx.save();
                ctx.globalCompositeOperation = 'destination-over';
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, m.canvas.width, m.canvas.height);
                ctx.restore();
            }
            return { canvas: m.canvas, toDocument: m.toDocument, background };
        },

        // ---------------------------------------------------------------------------------------------------------------
        // The box on the canvas (TransformOverlay.geometry, TransformOverlay.swift:64-81)

        // The box to draw and hit: with the Move tool, while Show Controls is on or an edit waits for Apply. Returns
        // { box } (a transform) or { corners } (a distortion), or null.
        transformOverlayShape() {
            if (this.tool !== 'move' || !this.doc.manifest) return null;
            const floating = this.selectTools.floating;
            if (floating) return { box: floating.draft };
            const e = this.transformEdit;
            if (!this.settings.showControls && !(e && e.persistent)) return null;
            if (e) return e.corners ? { corners: e.corners } : { box: e.draft };
            if (this.transformsAsGroup()) {
                const box = this.groupBox();
                return box ? { box } : null;
            }
            const a = this.activeLayer();
            if (!a || a.isGroup || !this.doc.entry(a.id).image || !this.effectivelyVisible(a)) return null;
            return { box: this.transformTargetsMask() ? this.maskTransformOf(a) : this.layerTransform(a) };
        },

        transformGeometry(toScreen) {
            // A filter panel hides the transform box while it is open, as it blocks the edit.
            if (this.filters && this.filters.isOpen) return null;
            const shape = this.transformOverlayShape();
            if (!shape) return null;
            return shape.corners ? TransformTool.cornerGeometry(shape.corners, toScreen) : TransformTool.geometry(shape.box, toScreen);
        },

        distortCursor() {
            return DISTORT_CURSOR;
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Snap targets (alignmentSnapTargets, Document/Guides.swift:247-285) for an edit moving several layers: View › Snap
        // and Snap To from the board's preferences (media/view-chrome.js), the moving layers left out.

        alignmentSnapTargets(moving = new Set(), includeCenters = true) {
            const p = { snap: true, snapBounds: true, snapLayers: true, snapGrid: false, grid: false, snapGuides: true, guides: true, ...(this.prefs || {}) };
            const xs = [], ys = [];
            if (!p.snap || !this.doc.manifest) return { xs, ys };
            const W = this.doc.width, H = this.doc.height;
            if (p.snapBounds) {
                xs.push(0, W);
                ys.push(0, H);
                if (includeCenters) { xs.push(W / 2); ys.push(H / 2); }
            }
            if (p.snapLayers) {
                for (const layer of this.drawOrder()) {
                    if (!this.doc.entry(layer.id).image || moving.has(layer.id)) continue;
                    const cs = TransformTool.corners(this.layerTransform(layer));
                    const minX = Math.min(...cs.map((c) => c.x)), maxX = Math.max(...cs.map((c) => c.x));
                    const minY = Math.min(...cs.map((c) => c.y)), maxY = Math.max(...cs.map((c) => c.y));
                    if (includeCenters) {
                        xs.push(roundHalfAway(minX), roundHalfAway((minX + maxX) / 2), roundHalfAway(maxX));
                        ys.push(roundHalfAway(minY), roundHalfAway((minY + maxY) / 2), roundHalfAway(maxY));
                    } else {
                        xs.push(roundHalfAway(minX), roundHalfAway(maxX));
                        ys.push(roundHalfAway(minY), roundHalfAway(maxY));
                    }
                }
            }
            // Hidden extras do not snap, matching Photoshop.
            if (p.snapGrid && p.grid && this.gridLines) { xs.push(...this.gridLines(W)); ys.push(...this.gridLines(H)); }
            if (p.snapGuides && p.guides) {
                const guides = this.displayedGuides ? this.displayedGuides() : this.doc.manifest.guides || [];
                for (const g of guides) (g.axis === 'vertical' ? xs : ys).push(g.position);
            }
            return { xs, ys };
        },

        // The layers an edit moves, which do not snap to themselves.
        transformMoving(e = this.transformEdit) {
            if (!e) return new Set();
            return e.group ? new Set(e.group.originals.keys()) : new Set([e.layerID]);
        },

        // ---------------------------------------------------------------------------------------------------------------
        // The Move bar (UI/TransformInspector.swift)

        // transformEdit.draft ?? editedTransform(active) ?? (0, 0, 1, 1); the floating pixels while transformed.
        moveBarValue() {
            const floating = this.selectTools.floating;
            if (floating) return floating.draft;
            if (this.transformEdit) return this.transformEdit.draft;
            const a = this.activeLayer();
            if (a && this.transformsAsGroup()) {
                const box = this.groupBox();
                if (box) return box;
            }
            if (a) return this.transformTargetsMask() ? this.maskTransformOf(a) : this.layerTransform(a);
            return { x: 0, y: 0, width: 1, height: 1, rotation: 0, flipX: false, flipY: false, sampling: 'High quality' };
        },

        // What 100% scale draws 1:1: transformPixelSize ?? the layer's size ?? the value's (TransformInspector.swift:64-66).
        moveBarPixelSize(value) {
            const e = this.transformEdit, floating = this.selectTools.floating;
            if (e && e.group) return { width: e.group.box.width, height: e.group.box.height };
            if (!e && this.transformsAsGroup()) {
                const box = this.groupBox();
                if (box) return box;
            }
            const a = this.activeLayer();
            if (floating) return { width: floating.image.width, height: floating.image.height };
            if (!this.transformTargetsMask() && a) {
                const image = this.doc.entry(a.id).image;
                if (image) return { width: image.width, height: image.height };
            }
            if (a) return this.layerTransform(a);
            return value;
        },

        moveBarPending() {
            return Boolean((this.transformEdit && this.transformEdit.persistent) || this.selectTools.floating);
        },

        moveBarHTML() {
            const field = (key, label, width, title = '') => `<span class="group"${title ? ` title="${title}"` : ''}><label class="caption scrub" data-scrub-transform="${key}">${label}</label><input class="num" data-transform="${key}" aria-label="${label}" style="width:${width}px"></span>`;
            const pending = this.moveBarPending();
            return `<span class="title">${this.transformTargetsMask() ? 'Transform Mask' : 'Transform'}</span>
                <label class="check" title="Select layers by clicking the canvas. Hold Command to turn it the other way while you click."><input type="checkbox" class="auto-select" ${this.settings.autoSelect !== Boolean(this.selectTools.heldCommand) ? 'checked' : ''}> Auto Select</label>
                <label class="check" title="Show the transform box and handles (⌘H). When hidden, drag anywhere to move the layer."><input type="checkbox" class="show-controls" ${this.settings.showControls ? 'checked' : ''}> Show Controls</label>
                <span class="group transform-fields">
                    ${field('x', 'X', 62)}${field('y', 'Y', 62)}${field('width', 'W', 62)}${field('height', 'H', 62)}
                    <button class="icon-button lock" title="Lock aspect ratio. Hold Shift while dragging a handle to turn it the other way." aria-label="Lock aspect ratio">${CB.icon(this.settings.lockRatio !== Boolean(this.selectTools.heldShift) ? 'link' : 'unlink')}</button>
                    <span class="group" title="Scale width and height together, about the center"><label class="caption scrub" data-scrub-transform="scale">Scale</label><input class="num" data-transform="scale" aria-label="Scale" style="width:56px"><span class="unit">%</span></span>
                    ${field('rotation', '°', 48)}
                    <select class="pop sampling" aria-label="Sampling"><option>Nearest</option><option>Smooth</option><option>High quality</option></select>
                    <button class="pill flip-h">Flip H</button>
                    <button class="pill flip-v">Flip V</button>
                </span>
                <span class="transform-buttons${pending ? ' shown' : ''}" ${pending ? '' : 'aria-hidden="true"'}>
                    <button class="pill transform-cancel" title="Cancel (Escape)">Cancel</button>
                    <button class="pill transform-apply" title="Apply (Return)">Apply</button>
                </span>`;
        },

        // A value typed, stepped or scrubbed previews at once; with no edit open it opens one from the fields, which
        // `finishMoveBar` applies (TransformInspector.change / finish). A floating selection or an edit waiting for
        // Apply takes it as part of that edit.
        changeMoveBar(update) {
            const floating = this.selectTools.floating;
            if (floating) {
                const next = { ...floating.draft };
                update(next, this.moveBarPixelSize(next));
                if (TransformTool.isValid(next)) floating.draft = next;
                this.changed();
                return;
            }
            if (!this.transformEdit) {
                if (!this.beginTransformEdit(false)) return;
                this.transformEdit.fromFields = true;
            }
            const next = { ...this.transformEdit.draft };
            update(next, this.moveBarPixelSize(next));
            this.previewTransformEdit(next);
        },

        finishMoveBar() {
            if (this.transformEdit && this.transformEdit.fromFields) this.commitTransformEdit();
        },

        // Each field's change (TransformInspector.swift:22-36, 89-100).
        moveBarSetter(key) {
            const lock = () => this.settings.lockRatio;
            return {
                x: (n) => (v) => { v.x = n; },
                y: (n) => (v) => { v.y = n; },
                width: (n) => (v) => { if (n < 1) return; if (lock()) v.height *= n / v.width; v.width = n; },
                height: (n) => (v) => { if (n < 1) return; if (lock()) v.width *= n / v.height; v.height = n; },
                scale: (n) => (v, pixels) => {
                    if (!(n > 0)) return;
                    const c = Transform.center(v);
                    v.width = (pixels.width * n) / 100;
                    v.height = (pixels.height * n) / 100;
                    v.x = c.x - v.width / 2;
                    v.y = c.y - v.height / 2;
                },
                rotation: (n) => (v) => { v.rotation = n % 360; },
            }[key];
        },

        moveBarFieldValue(key, value = this.moveBarValue()) {
            if (key === 'scale') return (value.width / Math.max(1, this.moveBarPixelSize(value).width)) * 100;
            return value[key];
        },

        bindMoveBar(el) {
            const fields = el.querySelector('.transform-fields');
            if (!fields) return;
            fields.querySelectorAll('input[data-transform]').forEach((input) => {
                const key = input.dataset.transform;
                input.addEventListener('input', () => {
                    const n = parse(input.value);
                    if (n !== null) this.changeMoveBar(this.moveBarSetter(key)(n));
                });
                // Leaving the field (Return, Escape, Tab, a click elsewhere) applies what it changed.
                input.addEventListener('blur', () => {
                    this.finishMoveBar();
                    this.refreshOptionValues();
                });
                input.addEventListener('keydown', (e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter' || e.key === 'Escape') {
                        e.preventDefault();
                        this.focusCanvas();
                    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        // ArrowStepper: one step, ten with Shift, written back as applied.
                        e.preventDefault();
                        const now = this.moveBarFieldValue(key);
                        const stepped = now + (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
                        this.changeMoveBar(this.moveBarSetter(key)(stepped));
                        input.value = formatted(stepped);
                    }
                });
            });
            // NumericScrub: sensitivity 1 per point, whole steps, the field's range; applied when let go.
            const ranges = { x: [-30000, 30000], y: [-30000, 30000], width: [1, 30000], height: [1, 30000], scale: [0.1, 30000], rotation: [-360, 360] };
            fields.querySelectorAll('[data-scrub-transform]').forEach((label) => label.addEventListener('pointerdown', (e) => {
                if (fields.classList.contains('disabled')) return;
                const key = label.dataset.scrubTransform, [lo, hi] = ranges[key];
                const start = e.clientX, from = this.moveBarFieldValue(key);
                let moved = false;
                label.setPointerCapture(e.pointerId);
                label.onpointermove = (m) => {
                    if (!moved && Math.abs(m.clientX - start) < 1) return;
                    moved = true;
                    const value = Math.min(hi, Math.max(lo, roundHalfAway(from + (m.clientX - start))));
                    this.changeMoveBar(this.moveBarSetter(key)(value));
                };
                label.onpointerup = () => {
                    label.onpointermove = null;
                    label.onpointerup = null;
                    if (moved) this.finishMoveBar();
                };
            }));
            const lock = el.querySelector('.lock');
            // The button shows the lock flipped while Shift is held; a click turns the setting itself over.
            if (lock) lock.addEventListener('click', () => {
                this.settings.lockRatio = !this.settings.lockRatio;
                this.renderOptions(true);
            });
            // The Sampling picker and the flips change the edit without finishing it (quirk 10.8).
            const sampling = el.querySelector('.sampling');
            if (sampling) sampling.addEventListener('change', () => this.changeMoveBar((v) => { v.sampling = sampling.value; }));
            const flipH = el.querySelector('.flip-h'), flipV = el.querySelector('.flip-v');
            if (flipH) flipH.addEventListener('click', () => this.changeMoveBar((v) => { v.flipX = !v.flipX; }));
            if (flipV) flipV.addEventListener('click', () => this.changeMoveBar((v) => { v.flipY = !v.flipY; }));
            const cancel = el.querySelector('.transform-cancel'), apply = el.querySelector('.transform-apply');
            if (cancel) cancel.addEventListener('click', () => { if (this.selectTools.floating) this.selectTools.cancelFloating(); else this.cancelTransformEdit(); });
            if (apply) apply.addEventListener('click', () => { if (this.selectTools.floating) this.selectTools.commitFloating(); else this.commitTransformEdit(); });
        },

        refreshMoveBar(el) {
            const fields = el.querySelector('.transform-fields');
            if (!fields) return;
            const value = this.moveBarValue();
            // Disabled with nothing to transform, and while distorted (TransformInspector.swift:45-46).
            const disabled = (!this.canTransform() && !this.transformEdit && !this.selectTools.floating) || Boolean(this.transformEdit && this.transformEdit.corners);
            fields.classList.toggle('disabled', disabled);
            fields.querySelectorAll('input, select, button').forEach((n) => { n.disabled = disabled; });
            // With no layer selected (a board choice, deselectLayers) the fields stay empty.
            const none = !this.activeID() && !this.transformEdit && !this.selectTools.floating;
            fields.querySelectorAll('input[data-transform]').forEach((input) => {
                if (document.activeElement !== input) input.value = none ? '' : formatted(this.moveBarFieldValue(input.dataset.transform, value));
            });
            const sampling = fields.querySelector('.sampling');
            if (sampling) sampling.value = value.sampling || 'High quality';
            const buttons = el.querySelector('.transform-buttons');
            if (buttons) {
                const pending = this.moveBarPending();
                buttons.classList.toggle('shown', pending);
                buttons.querySelectorAll('button').forEach((b) => { b.disabled = !this.transformEdit && !this.selectTools.floating; });
            }
        },

        // ---------------------------------------------------------------------------------------------------------------
        // Crop frame state shared with the Crop tool (media/crop.js)

        cancelCrop() {
            if (!this.cropEdit) return;
            this.cropEdit = null;
            this.view.drawOverlay();
            this.renderOptions(true);
        },
    };

    CB.TransformEdits = TransformEdits;
    CB.TransformFormat = { formatted, parse, toFixed2HalfEven };
})();
