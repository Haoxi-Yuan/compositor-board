'use strict';
// Affine maps and Compositor's LayerTransform (upstream Document/LayerTransform.swift). A transform places a layer's
// pixels in document space: `origin` and `size` are its unrotated bounds, `rotation` is degrees clockwise (y down)
// around the centre, flips mirror the pixels inside those bounds.

(function () {
    const CB = (window.CB = window.CB || {});

    // {a, b, c, d, e, f}: x' = a x + c y + e, y' = b x + d y + f (the Canvas 2D / Core Graphics convention).
    const Affine = {
        identity: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
        multiply(m, n) { // m after n
            return {
                a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b,
                c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d,
                e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f,
            };
        },
        translate: (m, x, y) => Affine.multiply(m, { a: 1, b: 0, c: 0, d: 1, e: x, f: y }),
        scale: (m, x, y) => Affine.multiply(m, { a: x, b: 0, c: 0, d: y, e: 0, f: 0 }),
        rotate(m, radians) {
            const cos = Math.cos(radians), sin = Math.sin(radians);
            return Affine.multiply(m, { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
        },
        invert(m) {
            const det = m.a * m.d - m.b * m.c;
            if (!det) return null;
            return {
                a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det,
                e: (m.c * m.f - m.d * m.e) / det, f: (m.b * m.e - m.a * m.f) / det,
            };
        },
        apply: (m, x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }),
        // Axis-aligned bounding box of a rectangle after the map.
        boundsOf(m, rect) {
            const pts = [
                Affine.apply(m, rect.x, rect.y), Affine.apply(m, rect.x + rect.width, rect.y),
                Affine.apply(m, rect.x, rect.y + rect.height), Affine.apply(m, rect.x + rect.width, rect.y + rect.height),
            ];
            const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
            const x = Math.min(...xs), y = Math.min(...ys);
            return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
        },
        setOn(ctx, m) { ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f); },
    };

    const Rect = {
        // CGRect.integral: floor the minimum, ceil the maximum.
        integral(r) {
            const x = Math.floor(r.x + 1e-9), y = Math.floor(r.y + 1e-9);
            return { x, y, width: Math.ceil(r.x + r.width - 1e-9) - x, height: Math.ceil(r.y + r.height - 1e-9) - y };
        },
        union(a, b) {
            if (!a) return b && { ...b };
            if (!b) return { ...a };
            const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
            return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
        },
        intersect(a, b) {
            const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
            const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
            if (right <= x || bottom <= y) return null;
            return { x, y, width: right - x, height: bottom - y };
        },
        inflate: (r, dx, dy = dx) => ({ x: r.x - dx, y: r.y - dy, width: r.width + 2 * dx, height: r.height + 2 * dy }),
        equal: (a, b) => a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height,
        contains: (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height,
    };

    // The manifest's transform record <-> a plain object, filling Compositor's defaults.
    function readTransform(record, fallbackSize) {
        const t = record || {};
        return {
            x: (t.origin && t.origin[0]) || 0,
            y: (t.origin && t.origin[1]) || 0,
            width: t.size ? t.size[0] : fallbackSize[0],
            height: t.size ? t.size[1] : fallbackSize[1],
            rotation: t.rotation || 0,
            flipX: Boolean(t.flipX),
            flipY: Boolean(t.flipY),
            sampling: t.sampling || 'High quality',
        };
    }

    function writeTransform(t) {
        return {
            origin: [t.x, t.y],
            size: [t.width, t.height],
            rotation: t.rotation,
            flipX: t.flipX,
            flipY: t.flipY,
            sampling: t.sampling,
        };
    }

    function radians(t) {
        return ((t.rotation % 360) * Math.PI) / 180;
    }

    function center(t) {
        return { x: t.x + t.width / 2, y: t.y + t.height / 2 };
    }

    // Upstream BrushRaster.pixelToDocument: pixel (0,0)-(width,height) of an image of that size onto its transform.
    function pixelToDocument(t, width, height) {
        const c = center(t);
        let m = Affine.translate(Affine.identity(), c.x, c.y);
        m = Affine.rotate(m, radians(t));
        m = Affine.scale(m, (t.width / width) * (t.flipX ? -1 : 1), (t.height / height) * (t.flipY ? -1 : 1));
        return Affine.translate(m, -width / 2, -height / 2);
    }

    CB.Affine = Affine;
    CB.Rect = Rect;
    CB.Transform = { read: readTransform, write: writeTransform, radians, center, pixelToDocument };
})();
