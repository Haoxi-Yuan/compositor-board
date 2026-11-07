'use strict';
// Compositor's Shape tool (upstream Document/ShapeTool.swift; derivation in docs/port-specs/shapes.md). Each drag makes
// one raster layer above the active one, 1 PNG pixel per document pixel, with a `shape` style in the manifest so the
// layer is drawn again, not resampled, when it is scaled. The paths emit the same cubic Beziers Core Graphics builds,
// so only anti-aliasing of edge pixels can differ.
// A board addition, not Compositor's: a rectangle or ellipse can be outlined instead of (or as well as) filled, as in
// Photoshop. The outline lies inside the shape, in the foreground color; with both, the inside takes the background
// color. Compositor's `shape` style has no outline, so such a layer is plain pixels in the manifest and its style lives
// in <name>.comp.board.json (layer-ops.js), drawn again when scaled while the layer still shows it.

(function () {
    const CB = (window.CB = window.CB || {});

    const KINDS = ['Rectangle', 'Ellipse', 'Line'];
    const PAINTS = ['Fill', 'Stroke', 'Stroke & Fill'];
    const K90 = 0.5522847498307936; // 4/3 * tan(pi/8)
    const MAX_PIXELS = 200000000;
    const MAX_SIDE = 30000;
    const DEFAULTS = { kind: 'Rectangle', paint: 'Fill', cornerRadius: 0, smoothing: false, lineWidth: 4, strokeWidth: 4 };

    const q = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
    const css = (style) => `rgb(${q(style.red)}, ${q(style.green)}, ${q(style.blue)})`;
    const rgb = (c) => css({ red: c[0], green: c[1], blue: c[2] });
    const outlined = (paint) => paint === 'Stroke' || paint === 'Stroke & Fill';

    function roundedRectPath(ctx, x, y, w, h, r) {
        const k = K90 * r, X = x + w, Y = y + h;
        ctx.moveTo(X, y + h / 2);
        ctx.lineTo(X, Y - r);
        ctx.bezierCurveTo(X, Y - r + k, X - r + k, Y, X - r, Y);
        ctx.lineTo(x + r, Y);
        ctx.bezierCurveTo(x + r - k, Y, x, Y - r + k, x, Y - r);
        ctx.lineTo(x, y + r);
        ctx.bezierCurveTo(x, y + r - k, x + r - k, y, x + r, y);
        ctx.lineTo(X - r, y);
        ctx.bezierCurveTo(X - r + k, y, X, y + r - k, X, y + r);
        ctx.closePath();
    }

    // Figma's cubic-arc-cubic corner at 60 % smoothing, backing off the smoothing (never the radius) when the corners
    // run out of room.
    function smoothedRectPath(ctx, x, y, w, h, radius) {
        const s = Math.min(0.6, Math.max(0, Math.min(w, h) / (2 * radius) - 1));
        if (!(s > 0)) {
            roundedRectPath(ctx, x, y, w, h, radius);
            return;
        }
        const reach = (1 + s) * radius;
        const angle = (s * Math.PI) / 4;
        const tangent = radius * Math.tan(angle / 2);
        const c = tangent * Math.cos(angle), d = tangent * Math.sin(angle);
        const arcLength = radius * Math.SQRT2 * Math.sin(((1 - s) * Math.PI) / 4);
        const b = (reach - arcLength - c - d) / 3, a = 2 * b;
        const a0 = -Math.PI / 2 + angle, a1 = -angle;
        const kr = (4 / 3) * Math.tan((a1 - a0) / 4) * radius;
        const ox = -radius, oy = radius;
        const p0 = [ox + radius * Math.cos(a0), oy + radius * Math.sin(a0)];
        const p3 = [ox + radius * Math.cos(a1), oy + radius * Math.sin(a1)];
        const c1 = [p0[0] - kr * Math.sin(a0), p0[1] + kr * Math.cos(a0)];
        const c2 = [p3[0] + kr * Math.sin(a1), p3[1] - kr * Math.cos(a1)];
        const corners = [[x + w, y], [x + w, y + h], [x, y + h], [x, y]];
        corners.forEach(([cx, cy], i) => {
            const t = (i * Math.PI) / 2, cos = Math.cos(t), sin = Math.sin(t);
            const P = (px, py) => [cx + px * cos - py * sin, cy + px * sin + py * cos];
            const start = P(-reach, 0);
            if (i === 0) ctx.moveTo(...start);
            else ctx.lineTo(...start);
            ctx.bezierCurveTo(...P(-reach + a, 0), ...P(-reach + a + b, 0), ...P(-reach + a + b + c, d));
            ctx.bezierCurveTo(...P(...c1), ...P(...c2), ...P(...p3));
            ctx.bezierCurveTo(...P(0, reach - a - b), ...P(0, reach - a), ...P(0, reach));
        });
        ctx.closePath();
    }

    function ellipsePath(ctx, x, y, w, h) {
        const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry, kx = K90 * rx, ky = K90 * ry;
        ctx.moveTo(x + w, cy);
        ctx.bezierCurveTo(x + w, cy + ky, cx + kx, y + h, cx, y + h);
        ctx.bezierCurveTo(cx - kx, y + h, x, cy + ky, x, cy);
        ctx.bezierCurveTo(x, cy - ky, cx - kx, y, cx, y);
        ctx.bezierCurveTo(cx + kx, y, x + w, cy - ky, x + w, cy);
        ctx.closePath();
    }

    // ShapeKind.path(in:cornerRadius:smoothing:)
    function fillPath(ctx, kind, x, y, w, h, cornerRadius, smoothing) {
        ctx.beginPath();
        if (kind === 'Ellipse') {
            ellipsePath(ctx, x, y, w, h);
            return;
        }
        const r = Math.min(Math.max(0, cornerRadius), w / 2, h / 2);
        if (!(r > 0)) ctx.rect(x, y, w, h);
        else if (smoothing) smoothedRectPath(ctx, x, y, w, h, r);
        else roundedRectPath(ctx, x, y, w, h, r);
    }

    function strokeLine(ctx, from, to, thickness) {
        ctx.beginPath();
        if (from[0] === to[0] && from[1] === to[1]) {
            // Core Graphics draws a zero-length round-capped segment as a disc; Canvas prunes it, so draw the disc.
            ctx.arc(from[0], from[1], thickness / 2, 0, 2 * Math.PI);
            ctx.fill();
            return;
        }
        ctx.lineWidth = thickness;
        ctx.lineCap = 'round';
        ctx.moveTo(...from);
        ctx.lineTo(...to);
        ctx.stroke();
    }

    // An outlined style's pixels: the outline is stroked twice its width along the shape's edge and the outer half cut
    // away, so its outer edge is the filled shape's own edge, anti-aliasing included.
    function outlineShape(ctx, style, w, h) {
        fillPath(ctx, style.kind, 0, 0, w, h, style.cornerRadius || 0, style.smoothing === true);
        ctx.lineWidth = 2 * Math.max(1, style.strokeWidth || 0);
        ctx.strokeStyle = rgb(style.stroke);
        if (style.fill) {
            ctx.fillStyle = rgb(style.fill);
            ctx.fill('nonzero');
            ctx.globalCompositeOperation = 'source-atop';
            ctx.stroke();
        } else {
            ctx.stroke();
            ctx.fillStyle = '#000';
            ctx.globalCompositeOperation = 'destination-in';
            ctx.fill('nonzero');
        }
        ctx.globalCompositeOperation = 'source-over';
    }

    // ShapeTool.shapeImage: the shape filling a (possibly fractional) box of w x h; the raster is trunc(w) x trunc(h).
    function shapeImage(style, w, h) {
        const W = Math.trunc(w), H = Math.trunc(h);
        const canvas = new OffscreenCanvas(Math.max(1, W), Math.max(1, H));
        // willReadFrequently keeps Chromium on its CPU rasterizer, so anti-aliasing is deterministic.
        const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
        ctx.fillStyle = ctx.strokeStyle = css(style);
        if (style.kind === 'Line') {
            const t = Math.max(1, style.lineWidth || 0);
            const ix = Math.min(t, w) / 2, iy = Math.min(t, h) / 2;
            const from = style.start ? [style.start[0] * w, style.start[1] * h] : [ix, iy];
            const to = style.end ? [style.end[0] * w, style.end[1] * h] : [w - ix, h - iy];
            strokeLine(ctx, from, to, t);
        } else if (outlined(style.paint)) {
            outlineShape(ctx, style, w, h);
        } else {
            fillPath(ctx, style.kind, 0, 0, w, h, style.cornerRadius || 0, style.smoothing === true);
            ctx.fill('nonzero');
        }
        return canvas;
    }

    // DragBox.rect: the box a drag from `anchor` to `point` spans, in whole pixels.
    const roundHalfAway = (v) => Math.sign(v) * Math.round(Math.abs(v));

    function dragBox(anchor, point, square, fromCenter) {
        let dx = roundHalfAway(point.x) - anchor.x, dy = roundHalfAway(point.y) - anchor.y;
        if (square) {
            const side = Math.max(Math.abs(dx), Math.abs(dy));
            dx = dx < 0 ? -side : side;
            dy = dy < 0 ? -side : side;
        }
        return fromCenter
            ? { x: anchor.x - Math.abs(dx), y: anchor.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 }
            : { x: Math.min(anchor.x, anchor.x + dx), y: Math.min(anchor.y, anchor.y + dy), width: Math.abs(dx), height: Math.abs(dy) };
    }

    // The draft between press and release. Kind, paint, radius and smoothing are fixed at the press; widths and colors
    // are read at release (and live by the preview).
    function beginDraft(point, options) {
        const anchor = { x: roundHalfAway(point.x), y: roundHalfAway(point.y) };
        return {
            kind: options.kind,
            anchor,
            rect: { x: anchor.x, y: anchor.y, width: 0, height: 0 },
            end: null,
            paint: options.kind === 'Line' ? 'Fill' : options.paint || 'Fill',
            cornerRadius: options.kind === 'Rectangle' ? options.cornerRadius : 0,
            smoothing: options.kind === 'Rectangle' && options.smoothing,
        };
    }

    function dragDraft(draft, point, square, fromCenter) {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return draft;
        const next = { ...draft };
        if (draft.kind === 'Line' && square) {
            // Shift on a line snaps its angle to eighths of a turn, keeping its length.
            const dx = point.x - draft.anchor.x, dy = point.y - draft.anchor.y;
            const angle = roundHalfAway(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
            const length = Math.hypot(dx, dy);
            next.end = { x: draft.anchor.x + Math.cos(angle) * length, y: draft.anchor.y + Math.sin(angle) * length };
            next.rect = dragBox(draft.anchor, next.end, false, fromCenter);
            return next;
        }
        if (draft.kind === 'Line') next.end = { ...point };
        next.rect = dragBox(draft.anchor, point, square, fromCenter);
        return next;
    }

    // "Rectangle 1", "Ellipse 2", ... skipping names already in the document.
    function nextName(kind, names) {
        let n = 1;
        while (names.has(`${kind} ${n}`)) n++;
        return `${kind} ${n}`;
    }

    // ShapeTool.finishShape: { image, transform, style } for the new layer, or { error } / null when nothing is made.
    // An outlined shape's style is the board's own ({ kind, paint, cornerRadius, smoothing, strokeWidth, stroke, fill }),
    // with `outlined` set: it goes to the board state, not the manifest.
    function finishDraft(draft, { lineWidth, color, strokeWidth, background }) {
        let rect = draft.rect, start = null, end = null;
        const thickness = lineWidth;
        if (draft.kind === 'Line') {
            const from = draft.anchor, to = draft.end || draft.anchor;
            rect = {
                x: Math.min(from.x, to.x) - thickness / 2, y: Math.min(from.y, to.y) - thickness / 2,
                width: Math.abs(to.x - from.x) + thickness, height: Math.abs(to.y - from.y) + thickness,
            };
            const unit = (p) => [rect.width > 0 ? (p.x - rect.x) / rect.width : 0.5, rect.height > 0 ? (p.y - rect.y) / rect.height : 0.5];
            start = unit(from);
            end = unit(to);
        }
        if (!(rect.width >= 1 && rect.height >= 1)) return null;
        const W = Math.trunc(rect.width), H = Math.trunc(rect.height);
        if (W * H > MAX_PIXELS) {
            return { error: 'That shape is too large. A shape can cover up to 200 megapixels.' };
        }
        const transform = { x: rect.x, y: rect.y, width: W, height: H, rotation: 0, flipX: false, flipY: false, sampling: 'High quality' };
        if (outlined(draft.paint)) {
            const outline = { kind: draft.kind, paint: draft.paint, cornerRadius: draft.cornerRadius, strokeWidth, stroke: color.slice(0, 3) };
            if (draft.smoothing) outline.smoothing = true;
            if (draft.paint === 'Stroke & Fill') outline.fill = background.slice(0, 3);
            return { image: shapeImage(outline, rect.width, rect.height), transform, style: outline, outlined: true };
        }
        const style = { kind: draft.kind, red: color[0], green: color[1], blue: color[2], cornerRadius: draft.cornerRadius };
        if (draft.smoothing) style.smoothing = true;
        if (draft.kind === 'Line') {
            style.lineWidth = thickness;
            style.start = start;
            style.end = end;
        }
        const image = shapeImage(style, rect.width, rect.height);
        return { image, transform, style };
    }

    // ShapeTool.redrawShape: after a scale, the style drawn at round(size); null if the size in pixels did not change.
    function redrawFor(style, transform, current) {
        const width = Math.max(1, Math.round(transform.width)), height = Math.max(1, Math.round(transform.height));
        if (current && width === current.width && height === current.height) return null;
        if (width * height > MAX_PIXELS || width > MAX_SIDE || height > MAX_SIDE) return null;
        return shapeImage(style, width, height);
    }

    // The draft drawn as vector in screen space (EditorCanvas.drawShapeDraft). `toScreen` maps document points to
    // canvas pixels; `scale` is canvas pixels per document pixel.
    function drawPreview(ctx, draft, { toScreen, scale, color, lineWidth, strokeWidth, background }) {
        if (!draft) return;
        const r = draft.rect;
        if (draft.kind === 'Line' ? !(r.width > 0 || r.height > 0) : !(r.width > 0 && r.height > 0)) return;
        ctx.save();
        ctx.fillStyle = ctx.strokeStyle = css({ red: color[0], green: color[1], blue: color[2] });
        if (draft.kind === 'Line') {
            const from = toScreen(draft.anchor), to = toScreen(draft.end || draft.anchor);
            strokeLine(ctx, [from.x, from.y], [to.x, to.y], Math.max(1, lineWidth * scale));
        } else {
            const mid = toScreen({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
            const w = r.width * scale, h = r.height * scale;
            fillPath(ctx, draft.kind, mid.x - w / 2, mid.y - h / 2, w, h, draft.cornerRadius * scale, draft.smoothing);
            if (outlined(draft.paint)) {
                // The outline's outer half clipped away, as outlineShape cuts it (it cannot erase what lies beneath).
                if (draft.paint === 'Stroke & Fill') {
                    ctx.fillStyle = rgb(background);
                    ctx.fill('nonzero');
                }
                ctx.clip('nonzero');
                ctx.lineWidth = 2 * Math.max(1, strokeWidth) * scale;
                ctx.stroke();
            } else ctx.fill('nonzero');
        }
        ctx.restore();
    }

    function pixelsOf(image) {
        if (!image.getContext) {
            const copy = new OffscreenCanvas(image.width, image.height);
            copy.getContext('2d').drawImage(image, 0, 0);
            image = copy;
        }
        return image.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, image.width, image.height).data;
    }

    // Whether `image` still shows what `drawn` holds: the same grid and pixels, allowing for what a PNG round trip does
    // to faint edges. Large layers are compared on a grid of at most about 250,000 pixels, which any brush stroke
    // crosses. Shared with the Pen's paths (pen-tool.js).
    function samePixels(image, drawn) {
        if (!image || image.deep || !drawn || image.width !== drawn.width || image.height !== drawn.height) return false;
        const a = pixelsOf(image), b = pixelsOf(drawn);
        const w = image.width, h = image.height, step = Math.max(1, Math.floor(Math.sqrt((w * h) / 250000)));
        const limit = Math.max(8, ((w * h) / (step * step)) * 0.0005);
        let off = 0;
        for (let y = 0; y < h; y += step) {
            for (let x = 0; x < w; x += step) {
                const i = (y * w + x) * 4;
                const alpha = Math.abs(a[i + 3] - b[i + 3]) > 3;
                const color = Math.max(a[i + 3], b[i + 3]) > 32
                    && (Math.abs(a[i] - b[i]) > 8 || Math.abs(a[i + 1] - b[i + 1]) > 8 || Math.abs(a[i + 2] - b[i + 2]) > 8);
                if ((alpha || color) && ++off > limit) return false;
            }
        }
        return true;
    }

    CB.Shapes = { KINDS, PAINTS, DEFAULTS, outlined, shapeImage, dragBox, beginDraft, dragDraft, finishDraft, nextName, redrawFor, drawPreview, css, samePixels };
})();
