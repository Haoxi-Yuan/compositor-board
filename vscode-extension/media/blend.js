'use strict';
// Compositor's 24 blend modes (upstream Document/LayerAppearance.swift, Rendering/SeparableBlend.swift). Sixteen are
// Canvas 2D composite operations with the same W3C math the app's Core Graphics and Core Image paths compute; the other
// eight are done per pixel with the Core Image formulas and the PDF basic compositing formula for alpha. Everything
// blends on gamma-encoded sRGB values, never linear light (docs/port-specs/compositing.md section 5).

(function () {
    const CB = (window.CB = window.CB || {});

    // In the order of the app's pop-up and of Shift +/- cycling.
    const MODES = [
        'Normal',
        'Darken', 'Multiply', 'Color Burn', 'Linear Burn',
        'Lighten', 'Screen', 'Color Dodge', 'Linear Dodge (Add)',
        'Overlay', 'Soft Light', 'Hard Light', 'Vivid Light', 'Linear Light', 'Pin Light', 'Hard Mix',
        'Difference', 'Exclusion', 'Subtract', 'Divide',
        'Hue', 'Saturation', 'Color', 'Luminosity',
    ];
    const GROUP_STARTS = new Set(['Darken', 'Lighten', 'Overlay', 'Difference', 'Hue']);

    const NATIVE = {
        Normal: 'source-over', Darken: 'darken', Multiply: 'multiply', 'Color Burn': 'color-burn',
        Lighten: 'lighten', Screen: 'screen', 'Color Dodge': 'color-dodge', Overlay: 'overlay',
        'Soft Light': 'soft-light', 'Hard Light': 'hard-light', Difference: 'difference', Exclusion: 'exclusion',
        Hue: 'hue', Saturation: 'saturation', Color: 'color', Luminosity: 'luminosity',
    };

    const burn = (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
    const dodge = (b, s) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)));
    const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

    const PER_PIXEL = {
        'Linear Burn': (b, s) => Math.max(0, b + s - 1),
        'Linear Dodge (Add)': (b, s) => Math.min(1, b + s),
        'Vivid Light': (b, s) => (s <= 0.5 ? burn(b, 2 * s) : dodge(b, 2 * s - 1)),
        'Linear Light': (b, s) => clamp01(b + 2 * s - 1),
        'Pin Light': (b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1)),
        'Hard Mix': (b, s) => (b + s > 1 ? 1 : 0),
        Subtract: (b, s) => Math.max(0, b - s),
        Divide: (b, s) => (s <= 0 ? (b > 0 ? 1 : 0) : Math.min(1, b / s)),
    };

    function native(mode) {
        return NATIVE[mode] || null;
    }

    // Blends straight-alpha `src` RGBA into `dst` (both from getImageData over the same rect) with one of the eight
    // per-pixel modes. `opacity` multiplies the source alpha, as the app's setAlpha does before blending.
    function blendPixels(dst, src, mode, opacity) {
        const f = PER_PIXEL[mode];
        for (let p = 0; p < dst.length; p += 4) {
            const as = (src[p + 3] / 255) * opacity;
            if (as === 0) continue;
            const ab = dst[p + 3] / 255, ao = as + ab - as * ab;
            for (let c = 0; c < 3; c++) {
                const s = src[p + c] / 255, b = dst[p + c] / 255;
                const co = s * as * (1 - ab) + b * ab * (1 - as) + as * ab * f(b, s);
                dst[p + c] = Math.round((co / ao) * 255);
            }
            dst[p + 3] = Math.round(ao * 255);
        }
    }

    function next(mode, step) {
        const i = MODES.indexOf(mode);
        return MODES[(i + step + MODES.length) % MODES.length];
    }

    CB.Blend = { MODES, GROUP_STARTS, native, blendPixels, next, isPerPixel: (mode) => Boolean(PER_PIXEL[mode]) };
})();
