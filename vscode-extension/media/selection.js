'use strict';
// The selection as the board holds it, Compositor's DocumentSelection (upstream Document/Selection.swift; derivation in
// docs/port-specs/selection.md): `null` for no selection, else { path, antialiased, feather } with `path` a list of
// elements ["M", x, y], ["L", x, y], ["Q", cx, cy, x, y], ["C", c1x, c1y, c2x, c2y, x, y], ["Z"] in document pixels.
// An empty path is an explicit empty selection: edits touch nothing. Booleans run in compositor-engine with Core
// Graphics' own path operations; this file draws, measures and rasterizes selections.

(function () {
    const CB = (window.CB = window.CB || {});

    // Paths are never mutated (moves make new arrays), so the Path2D and bounds of one are worked out once: the ants
    // redraw every 120 ms and hit tests run on every pointer move, and a Magic Wand outline can hold 100k elements.
    const path2DCache = new WeakMap(), boundsCache = new WeakMap();

    function toPath2D(elements) {
        let cached = path2DCache.get(elements);
        if (!cached) path2DCache.set(elements, (cached = buildPath2D(elements)));
        return cached;
    }

    function buildPath2D(elements) {
        const p = new Path2D();
        for (const e of elements) {
            switch (e[0]) {
                case 'M': p.moveTo(e[1], e[2]); break;
                case 'L': p.lineTo(e[1], e[2]); break;
                case 'Q': p.quadraticCurveTo(e[1], e[2], e[3], e[4]); break;
                case 'C': p.bezierCurveTo(e[1], e[2], e[3], e[4], e[5], e[6]); break;
                case 'Z': p.closePath(); break;
            }
        }
        return p;
    }

    function pathBounds(elements) {
        if (!boundsCache.has(elements)) boundsCache.set(elements, measureBounds(elements));
        return boundsCache.get(elements);
    }

    // CGPath.boundingBoxOfPath: tight bounds of the curve (extrema, not control points).
    function measureBounds(elements) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, cx = 0, cy = 0, sx = 0, sy = 0;
        const add = (x, y) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
        const extrema = (p0, p1, p2, p3, out) => {
            const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0;
            if (Math.abs(a) < 1e-12) { if (Math.abs(b) > 1e-12) out.push(-c / b); return; }
            const d = b * b - 4 * a * c;
            if (d < 0) return;
            const s = Math.sqrt(d);
            out.push((-b + s) / (2 * a), (-b - s) / (2 * a));
        };
        const at = (p0, p1, p2, p3, t) => { const u = 1 - t; return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3; };
        for (const e of elements) {
            if (e[0] === 'M') { cx = sx = e[1]; cy = sy = e[2]; add(cx, cy); }
            else if (e[0] === 'L') { cx = e[1]; cy = e[2]; add(cx, cy); }
            else if (e[0] === 'Z') { cx = sx; cy = sy; }
            else {
                const [x1, y1, x2, y2, x3, y3] = e[0] === 'C' ? e.slice(1)
                    : [cx + (2 / 3) * (e[1] - cx), cy + (2 / 3) * (e[2] - cy), e[3] + (2 / 3) * (e[1] - e[3]), e[4] + (2 / 3) * (e[2] - e[4]), e[3], e[4]];
                const ts = [];
                extrema(cx, x1, x2, x3, ts);
                for (const t of ts) if (t > 0 && t < 1) add(at(cx, x1, x2, x3, t), cy);
                const us = [];
                extrema(cy, y1, y2, y3, us);
                for (const t of us) if (t > 0 && t < 1) add(cx, at(cy, y1, y2, y3, t));
                cx = x3; cy = y3;
                add(cx, cy);
            }
        }
        return minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    function isEmpty(selection) {
        if (!selection) return false;
        const b = pathBounds(selection.path);
        return !b || b.width <= 0 || b.height <= 0;
    }

    // A path moved by whole pixels (outline moves and nudges never re-clip it).
    function translate(elements, dx, dy) {
        return elements.map((e) => (e[0] === 'Z' ? e : [e[0], ...e.slice(1).map((v, i) => v + (i % 2 ? dy : dx))]));
    }

    function mapped(elements, m) {
        return elements.map((e) => {
            if (e[0] === 'Z') return e;
            const out = [e[0]];
            for (let i = 1; i < e.length; i += 2) out.push(m.a * e[i] + m.c * e[i + 1] + m.e, m.b * e[i] + m.d * e[i + 1] + m.f);
            return out;
        });
    }

    function rectPath(x, y, w, h) {
        return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
    }

    // CGPath(ellipseIn:): four cubics from the rightmost point, clockwise on screen.
    function ellipsePath(x, y, w, h) {
        const k = 0.5522847498307936, rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry;
        return [['M', x + w, cy],
            ['C', x + w, cy + ry * k, cx + rx * k, y + h, cx, y + h],
            ['C', cx - rx * k, y + h, x, cy + ry * k, x, cy],
            ['C', x, cy - ry * k, cx - rx * k, y, cx, y],
            ['C', cx + rx * k, y, x + w, cy - ry * k, x + w, cy],
            ['Z']];
    }

    function polygonPath(points) {
        if (!points.length) return [];
        return [['M', points[0].x, points[0].y], ...points.slice(1).map((p) => ['L', p.x, p.y]), ['Z']];
    }

    function erf(x) {
        const s = Math.sign(x);
        x = Math.abs(x);
        const t = 1 / (1 + 0.3275911 * x);
        const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
        return s * y;
    }

    // CIGaussianBlur on a clamped image: separable, edges repeat outward, weights integrate the Gaussian per pixel.
    function gaussian(src, w, h, sigma) {
        const R = Math.max(1, Math.ceil(3 * sigma));
        const Phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
        const k = new Float64Array(2 * R + 1);
        let sum = 0;
        for (let i = -R; i <= R; i++) { k[i + R] = Phi((i + 0.5) / sigma) - Phi((i - 0.5) / sigma); sum += k[i + R]; }
        for (let i = 0; i < k.length; i++) k[i] /= sum;
        const tmp = new Float32Array(w * h), out = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            let v = 0;
            for (let i = -R; i <= R; i++) v += k[i + R] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
            tmp[y * w + x] = v;
        }
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            let v = 0;
            for (let i = -R; i <= R; i++) v += k[i + R] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
            out[y * w + x] = Math.min(255, Math.max(0, Math.round(v)));
        }
        return out;
    }

    // SelectionClip: coverage of the selection over its region of the canvas (`cov` null clips everything away).
    function clip(selection, W, H) {
        const none = { rect: { x: 0, y: 0, width: 0, height: 0 }, cov: null };
        const b = pathBounds(selection.path);
        if (!b || b.width <= 0 || b.height <= 0) return none;
        const grow = Math.ceil(selection.feather * 2) + 1;
        const x0 = Math.max(0, Math.floor(b.x - grow)), y0 = Math.max(0, Math.floor(b.y - grow));
        const x1 = Math.min(W, Math.ceil(b.x + b.width + grow)), y1 = Math.min(H, Math.ceil(b.y + b.height + grow));
        if (x1 - x0 < 1 || y1 - y0 < 1) return none;
        const w = x1 - x0, h = y1 - y0;
        const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.setTransform(1, 0, 0, 1, -x0, -y0);
        ctx.fillStyle = '#fff';
        ctx.fill(toPath2D(selection.path), 'nonzero');
        const rgba = ctx.getImageData(0, 0, w, h).data;
        let cov = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) cov[i] = rgba[i * 4 + 3];
        // Core Graphics' aliased fill is conservative: any pixel the interior touches is fully selected.
        if (!selection.antialiased && !(selection.feather > 0)) for (let i = 0; i < cov.length; i++) cov[i] = cov[i] > 0 ? 255 : 0;
        if (selection.feather > 0) cov = gaussian(cov, w, h, selection.feather / 2);
        return { rect: { x: x0, y: y0, width: w, height: h }, cov };
    }

    // Coverage (0-1) at a document point, bilinear between pixel centres; outside the region 0.
    function coverageAt(c, x, y) {
        if (!c.cov) return 0;
        const fx = x - c.rect.x - 0.5, fy = y - c.rect.y - 0.5;
        const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
        const w = c.rect.width, h = c.rect.height;
        const at = (px, py) => (px < 0 || py < 0 || px >= w || py >= h ? 0 : c.cov[py * w + px]);
        const v = (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty;
        return v / 255;
    }

    // Inverse without a geometry library: the canvas rectangle plus every subpath reversed; filled with nonzero this is
    // canvas minus the selection. Used only as the board's instant preview; the engine's answer replaces it.
    function invertPreview(selection, W, H) {
        const reversed = [];
        let sub = [];
        const flush = () => {
            if (sub.length < 2) { sub = []; return; }
            const pts = sub.slice().reverse();
            reversed.push(['M', pts[0][0], pts[0][1]], ...pts.slice(1).map((p) => ['L', p[0], p[1]]), ['Z']);
            sub = [];
        };
        for (const e of selection.path) {
            if (e[0] === 'M') { flush(); sub.push([e[1], e[2]]); }
            else if (e[0] === 'Z') flush();
            else sub.push([e[e.length - 2], e[e.length - 1]]);
        }
        flush();
        return { path: [...rectPath(0, 0, W, H), ...reversed], antialiased: selection.antialiased, feather: selection.feather };
    }

    let probeContext = null;
    const probe = () => probeContext || (probeContext = new OffscreenCanvas(1, 1).getContext('2d'));

    function contains(selection, x, y) {
        if (!selection || isEmpty(selection)) return false;
        const b = pathBounds(selection.path);
        if (x < b.x || y < b.y || x > b.x + b.width || y > b.y + b.height) return false;
        return probe().isPointInPath(toPath2D(selection.path), x, y, 'nonzero');
    }

    // Marching ants: a 1 px white line under a black 4/4 dash at `phase`, the path mapped (not the context) so the line
    // and dash stay in screen units.
    // Outlines over 20,000 elements are drawn at a coarser step on screen (TransformOverlay retraces them while zoomed
    // out): straight segments shorter than a screen pixel are merged. Small outlines are drawn exactly.
    function coarse(elements) {
        if (elements.length <= 20000) return elements;
        const out = [];
        let last = null;
        for (const e of elements) {
            if (e[0] === 'L' && last && Math.abs(e[1] - last[0]) < 1 && Math.abs(e[2] - last[1]) < 1) continue;
            out.push(e);
            if (e[0] !== 'Z') last = [e[e.length - 2], e[e.length - 1]];
        }
        return out;
    }

    let antsCache = null;
    function drawAnts(ctx, elements, toScreen, phase) {
        const m = toScreen;
        const key = [m.a, m.b, m.c, m.d, m.e, m.f].join(',');
        if (!antsCache || antsCache.elements !== elements || antsCache.key !== key) antsCache = { elements, key, path: buildPath2D(coarse(mapped(elements, m))) };
        const p = antsCache.path;
        ctx.save();
        ctx.lineWidth = 1;
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'miter';
        ctx.miterLimit = 10;
        ctx.setLineDash([]);
        ctx.strokeStyle = '#ffffff';
        ctx.stroke(p);
        ctx.setLineDash([4, 4]);
        ctx.lineDashOffset = phase;
        ctx.strokeStyle = '#000000';
        ctx.stroke(p);
        ctx.restore();
    }

    function same(a, b) {
        if (a === b) return true;
        if (!a || !b) return false;
        return a.antialiased === b.antialiased && a.feather === b.feather && JSON.stringify(a.path) === JSON.stringify(b.path);
    }

    CB.Selection = {
        toPath2D, pathBounds, isEmpty, translate, mapped, rectPath, ellipsePath, polygonPath, gaussian, clip, coverageAt,
        invertPreview, contains, drawAnts, same,
    };
})();
