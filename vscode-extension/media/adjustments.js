'use strict';
// Adjustment layers on the board: the settings model of upstream Document/LayerAdjustment.swift (kinds, defaults,
// isValid, the manifest's flat Hue/Saturation dictionaries) and ports of the kernels Compositor's export runs
// (LayerAdjustment.apply, Rendering/AdjustPixels.c, LevelsPixels.c, NoisePixels.c), with the scope rules of
// Rendering/LiveMaskRenderer.swift: the whole composite below as input, blend mode at full coverage, opacity, own and
// folder masks, clipping stacks. The kernels are bit-exact against the engine's `render`; the blurs are close
// (docs/port-specs/adjustments-effects.md sections 2-4).

(function () {
    const CB = (window.CB = window.CB || {});
    const f32 = Math.fround;
    // Swift's .rounded() and C's roundf: half away from zero (Math.round rounds half up, which differs below zero).
    const swiftRound = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));
    const clampN = (n, lo, hi, fallback) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback);

    // ---------------------------------------------------------------------------------------------------------------
    // Model (Document/LayerAdjustment.swift, ImageAdjustments.swift, Levels.swift, Curves.swift, HueSaturation.swift)

    // AdjustmentKind.allCases, the order of every menu that lists them.
    const KINDS = ['Hue/Saturation', 'Levels', 'Curves', 'Exposure', 'Gradient Map', 'Grain', 'Add Noise', 'Gaussian Blur',
        'Motion Blur', 'Invert', 'Black & White', 'Color Balance'];
    const isEditable = (kind) => kind !== 'Invert';
    // AdjustmentKind.filterKind: the Filter panel that edits a kind; Levels and Hue/Saturation have panels of their own.
    const FILTER_KIND = {
        Curves: 'Curves', 'Black & White': 'Black & White', 'Color Balance': 'Color Balance', Exposure: 'Exposure',
        'Gradient Map': 'Gradient Map', Grain: 'Grain', 'Gaussian Blur': 'Gaussian Blur', 'Motion Blur': 'Motion Blur', 'Add Noise': 'Add Noise',
    };

    const RANGES = ['Master', 'Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas'];
    const DEFAULT_BANDS = {
        Master: [0, 0, 360, 360], Reds: [315, 345, 15, 45], Yellows: [15, 45, 75, 105], Greens: [75, 105, 135, 165],
        Cyans: [135, 165, 195, 225], Blues: [195, 225, 255, 285], Magentas: [255, 285, 315, 345],
    };
    const identityRange = () => ({ black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 });
    const defaultLevels = () => ({ channel: 'RGB', ranges: [identityRange(), identityRange(), identityRange(), identityRange()] });
    const straightCurve = () => [{ x: 0, y: 0 }, { x: 255, y: 255 }];
    const defaultCurves = () => ({ channel: 'RGB', channels: [straightCurve(), straightCurve(), straightCurve(), straightCurve()] });
    const DEFAULTS = {
        exposure: () => ({ exposure: 0, offset: 0, gamma: 1 }),
        gradientMap: () => ({ shadows: { red: 0, green: 0, blue: 0 }, highlights: { red: 1, green: 1, blue: 1 }, reversed: false }),
        grain: () => ({ amount: 25, size: 1.5, roughness: 50, seed: 0 }),
        blackWhite: () => ({ reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintHue: 40, tintSaturation: 20 }),
        colorBalance: () => ({
            shadowCyanRed: 0, shadowMagentaGreen: 0, shadowYellowBlue: 0, midCyanRed: 0, midMagentaGreen: 0, midYellowBlue: 0,
            highlightCyanRed: 0, highlightMagentaGreen: 0, highlightYellowBlue: 0, preserveLuminosity: true,
        }),
    };
    const COLOR_BALANCE_KEYS = ['shadowCyanRed', 'shadowMagentaGreen', 'shadowYellowBlue', 'midCyanRed', 'midMagentaGreen', 'midYellowBlue',
        'highlightCyanRed', 'highlightMagentaGreen', 'highlightYellowBlue'];

    // The resolved settings of a record's adjustment (the optional blocks at their defaults, LayerAdjustment.swift:73-119).
    function resolved(adj) {
        return {
            kind: adj.kind,
            levels: adj.levels || defaultLevels(),
            curves: adj.curves || defaultCurves(),
            exposure: adj.exposureSettings || DEFAULTS.exposure(),
            gradientMap: adj.gradientMapSettings || DEFAULTS.gradientMap(),
            grain: adj.grainSettings || DEFAULTS.grain(),
            blackWhite: adj.blackWhiteSettings || DEFAULTS.blackWhite(),
            colorBalance: adj.colorBalanceSettings || DEFAULTS.colorBalance(),
            blurRadius: adj.blurRadius === undefined || adj.blurRadius === null ? 10 : adj.blurRadius,
            motionAngle: adj.motionAngle === undefined || adj.motionAngle === null ? 0 : adj.motionAngle,
            motionDistance: adj.motionDistance === undefined || adj.motionDistance === null ? 10 : adj.motionDistance,
            noiseAmount: adj.noiseAmount === undefined || adj.noiseAmount === null ? 10 : adj.noiseAmount,
            noiseGaussian: Boolean(adj.noiseGaussian),
            noiseMonochromatic: Boolean(adj.noiseMonochromatic),
            noiseSeed: adj.noiseSeed === undefined || adj.noiseSeed === null ? 0 : adj.noiseSeed,
            hsv: resolvedHSV(adj),
        };
    }

    // HueSaturationSettings in object form: { range, colorize, invertRange, adjustments: {Range: {hue, saturation,
    // lightness}}, bands: {Range: [falloffStart, rangeStart, rangeEnd, falloffEnd]} }. The manifest stores the two
    // dictionaries as flat key/value arrays (manifest.md section 2); a record without hsvSettings uses its legacy
    // hue/saturation/lightness/colorize on Master (resolvedHSV, LayerAdjustment.swift:53-55).
    function hsvSettings(range = 'Master', hue = 0, saturation = 0, lightness = 0, colorize = false) {
        const bands = {};
        for (const r of RANGES) bands[r] = DEFAULT_BANDS[r].slice();
        return { range, colorize, invertRange: false, adjustments: { [range]: { hue, saturation, lightness } }, bands };
    }
    function resolvedHSV(adj) {
        const s = adj.hsvSettings;
        if (!s) return hsvSettings('Master', adj.hue || 0, adj.saturation || 0, adj.lightness || 0, Boolean(adj.colorize));
        const out = { range: s.range || 'Master', colorize: Boolean(s.colorize), invertRange: Boolean(s.invertRange), adjustments: {}, bands: {} };
        const pairs = (list) => {
            const result = [];
            if (Array.isArray(list)) for (let i = 0; i + 1 < list.length; i += 2) result.push([list[i], list[i + 1]]);
            else if (list && typeof list === 'object') result.push(...Object.entries(list));
            return result;
        };
        for (const [k, v] of pairs(s.adjustments)) out.adjustments[k] = { hue: v.hue || 0, saturation: v.saturation || 0, lightness: v.lightness || 0 };
        for (const [k, v] of pairs(s.bands)) out.bands[k] = Array.isArray(v) ? v.slice() : [v.falloffStart, v.rangeStart, v.rangeEnd, v.falloffEnd];
        return out;
    }
    function hsvToManifest(s) {
        const adjustments = [], bands = [];
        for (const [k, v] of Object.entries(s.adjustments)) adjustments.push(k, { hue: v.hue, saturation: v.saturation, lightness: v.lightness });
        for (const [k, b] of Object.entries(s.bands)) bands.push(k, { falloffStart: b[0], rangeStart: b[1], rangeEnd: b[2], falloffEnd: b[3] });
        return { range: s.range, colorize: s.colorize, invertRange: s.invertRange, adjustments, bands };
    }
    const hsvIdentity = (s) => !s.colorize && Object.values(s.adjustments).every((a) => a.hue === 0 && a.saturation === 0 && a.lightness === 0);
    const COLORIZE_START = () => hsvSettings('Master', 0, 25, 0, true);

    // LevelRange.normalized (Levels.swift:14-25).
    function normalizedRange(r) {
        const black = clampN(r.black, 0, 254, 0);
        return { black, white: clampN(r.white, black + 1, 255, 255), gamma: clampN(r.gamma, 0.1, 9.99, 1),
            outputBlack: clampN(r.outputBlack, 0, 255, 0), outputWhite: clampN(r.outputWhite, 0, 255, 255) };
    }
    const sameRange = (a, b) => a.black === b.black && a.white === b.white && a.gamma === b.gamma && a.outputBlack === b.outputBlack && a.outputWhite === b.outputWhite;
    const levelsIdentity = (levels) => levels.ranges.every((r) => sameRange(normalizedRange(r), identityRange()));

    // CurvesSettings.isValid (Curves.swift:10-16).
    function curvesValid(c) {
        return Array.isArray(c.channels) && c.channels.length === 4 && c.channels.every((p) => p.length >= 2 && p.length <= 32
            && p[0].x === 0 && p[p.length - 1].x === 255
            && p.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y) && q.x >= 0 && q.x <= 255 && q.y >= 0 && q.y <= 255)
            && p.every((q, i) => i === 0 || p[i - 1].x < q.x));
    }
    const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
    const colorValid = (c) => ['red', 'green', 'blue'].every((k) => inRange(c[k], 0, 1));

    // LayerAdjustment.isValid (LayerAdjustment.swift:128-141): what the app refuses to load or to write.
    function isValid(adj) {
        const r = resolved(adj);
        const a = (h) => Number.isFinite(h) && Math.abs(h) <= 360;
        const p = (v) => Number.isFinite(v) && Math.abs(v) <= 100;
        return a(adj.hue || 0) && p(adj.saturation || 0) && p(adj.lightness || 0)
            && Object.values(r.hsv.adjustments).every((v) => a(v.hue) && p(v.saturation) && p(v.lightness))
            && Object.values(r.hsv.bands).every((b) => b.every(Number.isFinite))
            && r.levels.ranges.length === 4 && r.levels.ranges.every((x) => sameRange(x, normalizedRange(x))) && curvesValid(r.curves)
            && inRange(r.exposure.exposure, -20, 20) && inRange(r.exposure.offset, -0.5, 0.5) && inRange(r.exposure.gamma, 0.01, 9.99)
            && colorValid(r.gradientMap.shadows) && colorValid(r.gradientMap.highlights)
            && inRange(r.grain.amount, 0, 100) && inRange(r.grain.size, 0.5, 20) && inRange(r.grain.roughness, 0, 100)
            && ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'].every((k) => inRange(r.blackWhite[k], -200, 300))
            && inRange(r.blackWhite.tintHue, 0, 360) && inRange(r.blackWhite.tintSaturation, 0, 100)
            && COLOR_BALANCE_KEYS.every((k) => inRange(r.colorBalance[k], -100, 100))
            && inRange(r.blurRadius, 0.1, 250) && inRange(r.motionAngle, -90, 90) && inRange(r.motionDistance, 1, 2000)
            && inRange(r.noiseAmount, 0.1, 400);
    }

    // samplingMargin (LayerAdjustment.swift:120-127): how far a blur reads past what it writes.
    function samplingMargin(adj) {
        const r = resolved(adj);
        if (adj.kind === 'Gaussian Blur') return r.blurRadius * 3 + 2;
        if (adj.kind === 'Motion Blur') return r.motionDistance / 2 + 2;
        return 0;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Kernels on premultiplied RGBA bytes (Uint8Array, never Uint8ClampedArray: each port rounds as its C does)

    function toPremultiplied(d) {
        for (let i = 0; i < d.length; i += 4) {
            const a = d[i + 3];
            if (a === 255) continue;
            d[i] = Math.round((d[i] * a) / 255); d[i + 1] = Math.round((d[i + 1] * a) / 255); d[i + 2] = Math.round((d[i + 2] * a) / 255);
        }
        return d;
    }
    function toStraight(p, out) {
        for (let i = 0; i < p.length; i += 4) {
            const a = p[i + 3];
            for (let c = 0; c < 3; c++) out[i + c] = a ? Math.min(255, Math.round((p[i + c] * 255) / a)) : 0;
            out[i + 3] = a;
        }
    }

    // Levels (Levels.swift:26-30, 41-43, 68-70) and levels_apply (LevelsPixels.c:3-16).
    function rangeApply(r0, v) {
        const s = normalizedRange(r0);
        const input = Math.min(1, Math.max(0, (v * 255 - s.black) / (s.white - s.black)));
        return (s.outputBlack + Math.pow(input, 1 / s.gamma) * (s.outputWhite - s.outputBlack)) / 255;
    }
    function levelsTables(levels) {
        const t = new Float32Array(768);
        for (let c = 0; c < 3; c++) for (let i = 0; i < 256; i++) t[c * 256 + i] = rangeApply(levels.ranges[0], rangeApply(levels.ranges[c + 1], i / 255));
        return t;
    }
    function levelsValue(tables, c, value, alpha) {
        const x = f32(Math.min(255, f32(f32(value * 255) / alpha)));
        const lo = Math.trunc(x), hi = lo < 255 ? lo + 1 : 255;
        const t0 = tables[c * 256 + lo], t1 = tables[c * 256 + hi];
        const result = f32(t0 + f32(f32(t1 - t0) * f32(x - lo)));
        return Math.min(alpha, Math.max(0, swiftRound(f32(result * alpha))));
    }
    // The output for a channel depends only on (value, alpha): a 3 x 256 x 256 table built with levels_apply itself.
    const lutCache = new Map();
    function levelsLUT(tables, key) {
        if (key && lutCache.has(key)) return lutCache.get(key);
        const lut = new Uint8Array(3 * 65536);
        for (let c = 0; c < 3; c++) for (let a = 1; a < 256; a++) for (let v = 0; v < 256; v++) lut[c * 65536 + a * 256 + v] = levelsValue(tables, c, v, a);
        if (key) {
            if (lutCache.size > 16) lutCache.delete(lutCache.keys().next().value);
            lutCache.set(key, lut);
        }
        return lut;
    }
    function levelsApply(p, tables, key) {
        const lut = levelsLUT(tables, key);
        for (let i = 0; i < p.length; i += 4) {
            const a = p[i + 3];
            if (!a) continue;
            const row = a * 256;
            p[i] = lut[row + p[i]]; p[i + 1] = lut[65536 + row + p[i + 1]]; p[i + 2] = lut[131072 + row + p[i + 2]];
        }
    }

    // Curves (Curves.swift:17-38): the channel's own curve, then RGB.
    function curveValue(p, x) {
        let last = -1;
        for (let k = 0; k < p.length; k++) if (p[k].x <= x) last = k;
        const i = Math.min(p.length - 2, Math.max(0, last));
        const d = [];
        for (let k = 0; k + 1 < p.length; k++) d.push((p[k + 1].y - p[k].y) / (p[k + 1].x - p[k].x));
        const slope = (j) => (j === 0 ? d[0] : j === p.length - 1 ? d[d.length - 1] : d[j - 1] * d[j] <= 0 ? 0 : 2 / (1 / d[j - 1] + 1 / d[j]));
        const h = p[i + 1].x - p[i].x, t = Math.min(1, Math.max(0, (x - p[i].x) / h));
        const y = (2 * t * t * t - 3 * t * t + 1) * p[i].y + (t * t * t - 2 * t * t + t) * h * slope(i)
            + (-2 * t * t * t + 3 * t * t) * p[i + 1].y + (t * t * t - t * t) * h * slope(i + 1);
        return Math.min(255, Math.max(0, y));
    }
    function curvesTables(curves) {
        const t = new Float32Array(768);
        for (let c = 1; c <= 3; c++) for (let i = 0; i < 256; i++) t[(c - 1) * 256 + i] = curveValue(curves.channels[0], curveValue(curves.channels[c], i)) / 255;
        return t;
    }

    // Exposure (ImageAdjustments.swift:54-69): one table on all three channels.
    function exposureTables(e) {
        const scale = Math.pow(2, e.exposure);
        const table = new Float32Array(768);
        for (let index = 0; index < 256; index++) {
            const encoded = index / 255;
            let linear = encoded <= 0.04045 ? encoded / 12.92 : Math.pow((encoded + 0.055) / 1.055, 2.4);
            linear = Math.pow(Math.max(0, linear * scale + e.offset), 1 / e.gamma);
            const output = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
            table[index] = table[256 + index] = table[512 + index] = Math.min(1, Math.max(0, output));
        }
        return table;
    }

    // Invert (PixelInvert.swift:29-36): each premultiplied color becomes alpha - color.
    function invertApply(p) {
        for (let i = 0; i < p.length; i += 4) { const a = p[i + 3]; p[i] = a - p[i]; p[i + 1] = a - p[i + 1]; p[i + 2] = a - p[i + 2]; }
    }

    // Gradient Map (ImageAdjustments.swift:87-104, adjust_gradient_map AdjustPixels.c:17-39).
    function gradientMapTable(g) {
        const [dark, light] = g.reversed ? [g.highlights, g.shadows] : [g.shadows, g.highlights];
        const ch = (from, to, t) => Math.min(255, Math.max(0, swiftRound((from + (to - from) * t) * 255)));
        const table = new Uint8Array(768);
        for (let i = 0; i < 256; i++) {
            const t = i / 255;
            table[i * 3] = ch(dark.red, light.red, t); table[i * 3 + 1] = ch(dark.green, light.green, t); table[i * 3 + 2] = ch(dark.blue, light.blue, t);
        }
        return table;
    }
    function gradientMapApply(p, table) {
        for (let i = 0; i < p.length; i += 4) {
            const a = p[i + 3];
            if (a === 0) continue;
            let r = p[i], g = p[i + 1], b = p[i + 2];
            if (a < 255) {
                r = Math.min(255, Math.floor((r * 255 + (a >> 1)) / a));
                g = Math.min(255, Math.floor((g * 255 + (a >> 1)) / a));
                b = Math.min(255, Math.floor((b * 255 + (a >> 1)) / a));
            }
            const k = Math.min(255, Math.floor((2126 * r + 7152 * g + 722 * b + 5000) / 10000)) * 3;
            p[i] = Math.floor((table[k] * a + 127) / 255);
            p[i + 1] = Math.floor((table[k + 1] * a + 127) / 255);
            p[i + 2] = Math.floor((table[k + 2] * a + 127) / 255);
        }
    }

    // Black & White (adjust_black_white, AdjustPixels.c:120-162), float math as in C.
    function blackWhiteApply(p, bw) {
        const w = [bw.reds, bw.yellows, bw.greens, bw.cyans, bw.blues, bw.magentas].map((v) => f32(v / 100));
        const tintSat = bw.tintSaturation / 100;
        for (let i = 0; i < p.length; i += 4) {
            const alpha = p[i + 3];
            if (!alpha) continue;
            let r = f32(f32(p[i] * 255) / alpha), g = f32(f32(p[i + 1] * 255) / alpha), b = f32(f32(p[i + 2] * 255) / alpha);
            r = f32(Math.min(255, r) / 255); g = f32(Math.min(255, g) / 255); b = f32(Math.min(255, b) / 255);
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            const md = f32(f32(f32(f32(r + g) + b) - mx) - mn);
            let primary, secondary;
            if (mx === r) { primary = 0; secondary = g >= b ? 1 : 5; }
            else if (mx === g) { primary = 2; secondary = r >= b ? 1 : 3; }
            else { primary = 4; secondary = g >= r ? 3 : 5; }
            let gray = f32(f32(mn + f32(f32(md - mn) * w[secondary])) + f32(f32(mx - md) * w[primary]));
            gray = Math.min(1, Math.max(0, gray));
            let oR = gray, oG = gray, oB = gray;
            if (bw.tint && tintSat > 0) {
                const c = (1 - Math.abs(2 * gray - 1)) * tintSat, hp = (bw.tintHue % 360) / 60;
                const xx = c * (1 - Math.abs((hp % 2) - 1));
                let r1 = 0, g1 = 0, b1 = 0;
                if (hp < 1) { r1 = c; g1 = xx; } else if (hp < 2) { r1 = xx; g1 = c; } else if (hp < 3) { g1 = c; b1 = xx; }
                else if (hp < 4) { g1 = xx; b1 = c; } else if (hp < 5) { r1 = xx; b1 = c; } else { r1 = c; b1 = xx; }
                const m = gray - c / 2;
                oR = f32(Math.min(1, Math.max(0, r1 + m))); oG = f32(Math.min(1, Math.max(0, g1 + m))); oB = f32(Math.min(1, Math.max(0, b1 + m)));
            }
            p[i] = Math.min(alpha, Math.max(0, swiftRound(f32(oR * alpha))));
            p[i + 1] = Math.min(alpha, Math.max(0, swiftRound(f32(oG * alpha))));
            p[i + 2] = Math.min(alpha, Math.max(0, swiftRound(f32(oB * alpha))));
        }
    }

    // Color Balance (adjust_color_balance and tonal_weights, AdjustPixels.c:166-206), with tonal_weights inlined.
    function colorBalanceApply(p, cb) {
        const all = COLOR_BALANCE_KEYS.map((k) => cb[k]);
        if (all.every((v) => v === 0)) return;
        const S = all.slice(0, 3).map((v) => f32(v / 100)), M = all.slice(3, 6).map((v) => f32(v / 100)), H = all.slice(6, 9).map((v) => f32(v / 100));
        const A = f32(0.25), B = f32(0.333), SCALE = f32(0.7), L0 = f32(0.299), L1 = f32(0.587), L2 = f32(0.114), TINY = f32(0.0001);
        const c = new Float64Array(3);
        const luma = () => f32(f32(f32(L0 * c[0]) + f32(L1 * c[1])) + f32(L2 * c[2]));
        for (let i = 0; i < p.length; i += 4) {
            const alpha = p[i + 3];
            if (!alpha) continue;
            for (let k = 0; k < 3; k++) c[k] = f32(Math.min(255, f32(f32(p[i + k] * 255) / alpha)) / 255);
            const before = luma();
            for (let k = 0; k < 3; k++) {
                const v = c[k];
                const s = Math.min(1, Math.max(0, f32(f32(f32(v - B) / -A) + 0.5)));
                const h = Math.min(1, Math.max(0, f32(f32(f32(f32(v + B) - 1) / A) + 0.5)));
                const m1 = Math.min(1, Math.max(0, f32(f32(f32(v - B) / A) + 0.5)));
                const m2 = Math.min(1, Math.max(0, f32(f32(f32(f32(v + B) - 1) / -A) + 0.5)));
                const ws = f32(s * SCALE), wm = f32(f32(m1 * m2) * SCALE), wh = f32(h * SCALE);
                c[k] = Math.min(1, Math.max(0, f32(v + f32(f32(f32(S[k] * ws) + f32(M[k] * wm)) + f32(H[k] * wh)))));
            }
            if (cb.preserveLuminosity) {
                const after = luma();
                if (after > TINY) { const ratio = f32(before / after); for (let k = 0; k < 3; k++) c[k] = Math.min(1, Math.max(0, f32(c[k] * ratio))); }
            }
            for (let k = 0; k < 3; k++) p[i + k] = Math.min(alpha, Math.max(0, swiftRound(f32(c[k] * alpha))));
        }
    }

    // Hue/Saturation (HueSaturation.swift:40-51, 266-391): a 33-point cube built in double, applied trilinear in float
    // (cube_apply, LevelsPixels.c:31-60).
    const forward = (from, to) => { const d = (to - from) % 360; return d < 0 ? d + 360 : d; };
    function bandWeight([fs, rs, re, fe], hue) {
        const span = forward(fs, fe);
        if (!(span > 0)) return 1;
        const position = forward(fs, hue);
        if (position > span) return 0;
        const rampIn = forward(fs, rs), plateauEnd = forward(fs, re);
        if (position < rampIn) return rampIn > 0 ? position / rampIn : 1;
        if (position <= plateauEnd) return 1;
        const rampOut = span - plateauEnd;
        return rampOut > 0 ? (span - position) / rampOut : 1;
    }
    function hsWeight(s, range, hue) {
        if (range === 'Master') return 1;
        const w = bandWeight(s.bands[range] || DEFAULT_BANDS[range], hue);
        return s.invertRange && range === s.range ? 1 - w : w;
    }
    function hueResponse(s) {
        const out = [];
        for (let degree = 0; degree <= 360; degree++) {
            let shift = 0, sat = 0, light = 0;
            for (const [range, a] of Object.entries(s.adjustments)) {
                if (a.hue === 0 && a.saturation === 0 && a.lightness === 0) continue;
                const w = hsWeight(s, range, degree);
                if (!(w > 0)) continue;
                shift += a.hue * w; sat += a.saturation * w; light += a.lightness * w;
            }
            out.push([shift, sat, light]);
        }
        return out;
    }
    function adjustedSaturation(sat, amount0) {
        const amount = Math.min(1, Math.max(-1, amount0 / 100));
        if (!(amount > 0)) return Math.max(0, sat * (1 + amount));
        return amount >= 1 ? (sat > 0 ? 1 : 0) : Math.min(1, sat / (1 - amount));
    }
    function toHSL(r, g, b) {
        const high = Math.max(r, g, b), low = Math.min(r, g, b), l = (high + low) / 2, delta = high - low;
        if (!(delta > 0)) return [0, 0, l];
        const sat = delta / (1 - Math.abs(2 * l - 1));
        let hue = high === r ? (g - b) / delta : high === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
        hue *= 60;
        if (hue < 0) hue += 360;
        return [hue, Math.min(1, sat), l];
    }
    function toRGB(hue, sat, l) {
        if (!(sat > 0)) return [l, l, l];
        const chroma = (1 - Math.abs(2 * l - 1)) * sat, sector = hue / 60;
        const second = chroma * (1 - Math.abs((sector % 2) - 1)), base = l - chroma / 2;
        const [r, g, b] = [[chroma, second, 0], [second, chroma, 0], [0, chroma, second], [0, second, chroma], [second, 0, chroma]][Math.trunc(sector)] || [chroma, 0, second];
        const c = (v) => Math.min(1, Math.max(0, v + base));
        return [c(r), c(g), c(b)];
    }
    function hsAdjust(r, g, b, s, response) {
        let [hue, sat, light] = toHSL(r, g, b), amountL;
        if (s.colorize) {
            const a = s.adjustments[s.range] || { hue: 0, saturation: 0, lightness: 0 };
            hue = a.hue % 360; sat = Math.min(1, Math.max(0, a.saturation / 100)); amountL = a.lightness / 100;
        } else {
            const sampled = response[Math.min(response.length - 1, Math.max(0, swiftRound(hue)))];
            amountL = sampled[2] / 100;
            hue = (hue + sampled[0]) % 360;
            if (hue < 0) hue += 360;
            sat = adjustedSaturation(sat, sampled[1]);
        }
        const amount = Math.min(1, Math.max(-1, amountL));
        light = amount >= 0 ? light + (1 - light) * amount : light * (1 + amount);
        return toRGB(hue, sat, Math.min(1, Math.max(0, light)));
    }
    const cubeCache = new Map();
    function hsCube(s) {
        const key = JSON.stringify(s);
        if (cubeCache.has(key)) return cubeCache.get(key);
        const n = 33, response = hueResponse(s), cube = new Float32Array(n * n * n * 4);
        let k = 0;
        for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
            const c = hsAdjust(r / 32, g / 32, b / 32, s, response);
            cube[k] = c[0]; cube[k + 1] = c[1]; cube[k + 2] = c[2]; cube[k + 3] = 1; k += 4;
        }
        if (cubeCache.size > 8) cubeCache.delete(cubeCache.keys().next().value);
        cubeCache.set(key, cube);
        return cube;
    }
    // shiftedHue (HueSaturation.swift): the hue a spectrum slice becomes, for the "after" bar.
    function shiftedHue(hue, s) {
        let shift = 0;
        for (const [range, a] of Object.entries(s.adjustments)) if (a.hue !== 0) shift += a.hue * hsWeight(s, range, hue);
        const shifted = (hue + shift) % 360;
        return shifted < 0 ? shifted + 360 : shifted;
    }
    function cubeApply(p, cube, n = 33) {
        const scale = f32((n - 1) / 255), sy = n * 4, sz = n * n * 4;
        const pos = [0, 0, 0], fr = [0, 0, 0], lo = [0, 0, 0];
        for (let i = 0; i < p.length; i += 4) {
            const alpha = p[i + 3];
            if (!alpha) continue;
            for (let c = 0; c < 3; c++) {
                pos[c] = f32(f32(Math.min(255, f32(f32(p[i + c] * 255) / alpha))) * scale);
                lo[c] = Math.min(n - 2, Math.trunc(pos[c]));
                fr[c] = f32(pos[c] - lo[c]);
            }
            const base = (lo[0] + lo[1] * n + lo[2] * n * n) * 4;
            for (let c = 0; c < 3; c++) {
                const o = base + c;
                const x00 = f32(cube[o] + f32(f32(cube[o + 4] - cube[o]) * fr[0]));
                const x10 = f32(cube[o + sy] + f32(f32(cube[o + sy + 4] - cube[o + sy]) * fr[0]));
                const x01 = f32(cube[o + sz] + f32(f32(cube[o + sz + 4] - cube[o + sz]) * fr[0]));
                const x11 = f32(cube[o + sz + sy] + f32(f32(cube[o + sz + sy + 4] - cube[o + sz + sy]) * fr[0]));
                const y0 = f32(x00 + f32(f32(x10 - x00) * fr[1])), y1 = f32(x01 + f32(f32(x11 - x01) * fr[1]));
                p[i + c] = Math.min(alpha, Math.max(0, swiftRound(f32(f32(y0 + f32(f32(y1 - y0) * fr[2])) * alpha))));
            }
        }
    }

    // Grain (adjust_grain, AdjustPixels.c:41-106): document-anchored through `originX/Y`.
    function mix32(x) {
        x = (x ^ (x >>> 16)) >>> 0; x = Math.imul(x, 0x7feb352d) >>> 0;
        x = (x ^ (x >>> 15)) >>> 0; x = Math.imul(x, 0x846ca68b) >>> 0;
        return (x ^ (x >>> 16)) >>> 0;
    }
    function lattice(ix, iy, seed) {
        const h = mix32((Math.imul(ix >>> 0, 0x9E3779B1) ^ mix32((Math.imul(iy >>> 0, 0x85EBCA77) ^ seed) >>> 0)) >>> 0);
        return f32(f32(f32((h & 0xFFFF) / 65535) + f32((h >>> 16) / 65535)) - 1);
    }
    function grainField(u, v, scale, seed) {
        const cellX = Math.floor(u / scale), cellY = Math.floor(v / scale);
        let tx = f32(u / scale - cellX), ty = f32(v / scale - cellY);
        tx = f32(f32(tx * tx) * f32(3 - f32(2 * tx))); ty = f32(f32(ty * ty) * f32(3 - f32(2 * ty)));
        const n00 = lattice(cellX, cellY, seed), n10 = lattice(cellX + 1, cellY, seed);
        const n01 = lattice(cellX, cellY + 1, seed), n11 = lattice(cellX + 1, cellY + 1, seed);
        const top = f32(n00 + f32(f32(n10 - n00) * tx)), bottom = f32(n01 + f32(f32(n11 - n01) * tx));
        return f32(f32(top + f32(f32(bottom - top) * ty)) * f32(1.6));
    }
    function grainApply(p, w, h, g, originX = 0, originY = 0, unitsPerPixel = 1) {
        if (!(g.amount > 0)) return;
        const size = g.size > 0 ? g.size : 1, seed = g.seed >>> 0;
        const strength = f32(f32(f32(g.amount > 100 ? 1 : g.amount / 100) * f32(0.35)) * 255);
        const rough = f32(g.roughness < 0 ? 0 : g.roughness > 100 ? 1 : g.roughness / 100);
        const fineSeed = mix32((seed ^ 0xA511E9B3) >>> 0), detail = Math.max(0.5, size * 0.35);
        const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
        const K0 = f32(0.2126), K1 = f32(0.7152), K2 = f32(0.0722), D0 = f32(0.4), D1 = f32(2.4);
        for (let y = 0; y < h; y++) {
            const v = originY + (y + 0.5) * unitsPerPixel;
            for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4, a = p[i + 3];
                if (a === 0) continue;
                const u = originX + (x + 0.5) * unitsPerPixel;
                const smooth = grainField(u, v, size, seed), fine = grainField(u, v, detail, fineSeed);
                const noise = f32(smooth + f32(f32(fine - smooth) * rough));
                const un = a === 255 ? 1 : f32(255 / a);
                const r = f32(p[i] * un), gg = f32(p[i + 1] * un), b = f32(p[i + 2] * un);
                let level = f32(f32(f32(f32(K0 * r) + f32(K1 * gg)) + f32(K2 * b)) / 255);
                if (level > 1) level = 1;
                const delta = f32(f32(noise * strength) * f32(D0 + f32(f32(D1 * level) * f32(1 - level))));
                const cov = f32(a / 255);
                p[i] = Math.trunc(f32(f32(cl(f32(r + delta)) * cov) + 0.5));
                p[i + 1] = Math.trunc(f32(f32(cl(f32(gg + delta)) * cov) + 0.5));
                p[i + 2] = Math.trunc(f32(f32(cl(f32(b + delta)) * cov) + 0.5));
            }
        }
    }

    // Add Noise (noise_add_at, NoisePixels.c:20-49).
    const noiseUnit = (key) => f32((mix32(key) >>> 8) * f32(1 / 16777216));
    function addNoiseApply(p, w, h, amount0, gaussian, mono, seed, ox = 0, oy = 0) {
        const spread = f32(f32(f32(Math.min(400, Math.max(0.1, amount0))) / 100) * f32(127.5));
        const TWO_PI = f32(6.2831853), TWO_THIRDS = f32(2 / 3);
        seed >>>= 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4, alpha = p[i + 3];
            if (!alpha) continue;
            const px = (ox + x) >>> 0, py = (oy + y) >>> 0;
            const base = mix32((seed ^ mix32((Math.imul(px, 0x9e3779b9) ^ mix32(Math.imul(py, 0x85ebca6b) >>> 0)) >>> 0)) >>> 0);
            for (let c = 0; c < 3; c++) {
                const key = mono ? base : (base + Math.imul(c, 0x9e3779b9)) >>> 0;
                let n;
                if (gaussian) {
                    const u1 = noiseUnit(key), u2 = noiseUnit((key ^ 0x68e31da4) >>> 0);
                    n = f32(f32(f32(f32(Math.sqrt(f32(-2 * Math.log(f32(1 - u1))))) * f32(Math.cos(f32(TWO_PI * u2)))) * spread) * TWO_THIRDS);
                } else n = f32(f32(f32(noiseUnit(key) * 2) - 1) * spread);
                let value = f32(f32(f32(p[i + c] * 255) / alpha) + n);
                value = value < 0 ? 0 : value > 255 ? 255 : value;
                p[i + c] = swiftRound(f32(f32(value * alpha) / 255));
            }
        }
    }

    // Gaussian Blur (section 3.11): Core Image's Gaussian with sigma = radius on premultiplied, gamma-encoded values,
    // transparent outside the target: separable, taps |i| <= ceil(4 sigma). Large radii blur a copy reduced by a power
    // of two and enlarge it again, as Core Image does internally.
    function gaussianKernel(sigma) {
        const reach = Math.ceil(4 * sigma), k = new Float64Array(2 * reach + 1);
        let total = 0;
        for (let i = -reach; i <= reach; i++) total += k[i + reach] = Math.exp(-(i * i) / (2 * sigma * sigma));
        for (let i = 0; i < k.length; i++) k[i] /= total;
        return { k, reach };
    }
    function blurPlanes(src, w, h, sigma) {
        const { k, reach } = gaussianKernel(sigma);
        const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
        for (let y = 0; y < h; y++) {
            const row = y * w;
            for (let x = 0; x < w; x++) {
                let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
                const lo = Math.max(-reach, -x), hi = Math.min(reach, w - 1 - x);
                for (let t = lo; t <= hi; t++) {
                    const wk = k[t + reach], j = (row + x + t) * 4;
                    a0 += src[j] * wk; a1 += src[j + 1] * wk; a2 += src[j + 2] * wk; a3 += src[j + 3] * wk;
                }
                const i = (row + x) * 4;
                tmp[i] = a0; tmp[i + 1] = a1; tmp[i + 2] = a2; tmp[i + 3] = a3;
            }
        }
        for (let y = 0; y < h; y++) {
            const lo = Math.max(-reach, -y), hi = Math.min(reach, h - 1 - y);
            for (let x = 0; x < w; x++) {
                let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
                for (let t = lo; t <= hi; t++) {
                    const wk = k[t + reach], j = ((y + t) * w + x) * 4;
                    a0 += tmp[j] * wk; a1 += tmp[j + 1] * wk; a2 += tmp[j + 2] * wk; a3 += tmp[j + 3] * wk;
                }
                const i = (y * w + x) * 4;
                out[i] = a0; out[i + 1] = a1; out[i + 2] = a2; out[i + 3] = a3;
            }
        }
        return out;
    }
    function gaussianApply(p, w, h, sigma) {
        if (!(sigma > 0)) return;
        const factor = sigma > 8 ? Math.pow(2, Math.floor(Math.log2(sigma / 4))) : 1;
        let planes;
        if (factor === 1) planes = blurPlanes(Float32Array.from(p), w, h, sigma);
        else {
            // Reduced by `factor` (box average), blurred so that box, blur and the bilinear enlargement add up to sigma.
            const sw = Math.ceil(w / factor), sh = Math.ceil(h / factor), small = new Float32Array(sw * sh * 4);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4, j = (Math.floor(y / factor) * sw + Math.floor(x / factor)) * 4;
                for (let c = 0; c < 4; c++) small[j + c] += p[i + c];
            }
            const area = factor * factor;
            for (let i = 0; i < small.length; i++) small[i] /= area;
            const reduced = Math.sqrt(Math.max(0.25, sigma * sigma - (factor * factor - 1) / 12 - (factor * factor) / 6)) / factor;
            const blurred = blurPlanes(small, sw, sh, reduced);
            planes = new Float32Array(p.length);
            for (let y = 0; y < h; y++) {
                const fy = (y + 0.5) / factor - 0.5, iy = Math.floor(fy), ty = fy - iy;
                const y0 = Math.max(0, Math.min(sh - 1, iy)), y1 = Math.max(0, Math.min(sh - 1, iy + 1));
                for (let x = 0; x < w; x++) {
                    const fx = (x + 0.5) / factor - 0.5, ix = Math.floor(fx), tx = fx - ix;
                    const x0 = Math.max(0, Math.min(sw - 1, ix)), x1 = Math.max(0, Math.min(sw - 1, ix + 1));
                    const i = (y * w + x) * 4;
                    for (let c = 0; c < 4; c++) {
                        const v00 = blurred[(y0 * sw + x0) * 4 + c], v10 = blurred[(y0 * sw + x1) * 4 + c];
                        const v01 = blurred[(y1 * sw + x0) * 4 + c], v11 = blurred[(y1 * sw + x1) * 4 + c];
                        planes[i + c] = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
                    }
                }
            }
        }
        for (let i = 0; i < p.length; i += 4) {
            const a = Math.min(255, Math.max(0, Math.round(planes[i + 3])));
            p[i + 3] = a;
            for (let c = 0; c < 3; c++) p[i + c] = Math.min(a, Math.max(0, Math.round(planes[i + c])));
        }
    }

    // Motion Blur (section 3.12): a Gaussian along (cos a, -sin a) with sigma = distance / sqrt(12) (Filters.swift:235-238,
    // 297-303), bilinear taps, transparent outside the target; very long streaks take taps a sixteenth of sigma apart.
    function motionBlurApply(p, w, h, angle, distance) {
        const sigma = distance / Math.sqrt(12);
        if (!(sigma > 0)) return;
        const reach = Math.ceil(4 * sigma), step = Math.max(1, sigma / 16);
        const taps = [], weights = [];
        let total = 0;
        for (let t = -reach; t <= reach + 1e-9; t += step) { const wgt = Math.exp(-(t * t) / (2 * sigma * sigma)); taps.push(t); weights.push(wgt); total += wgt; }
        const rad = (angle * Math.PI) / 180, dx = Math.cos(rad), dy = -Math.sin(rad);
        const src = Float32Array.from(p);
        const at = (x, y, c) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : src[(y * w + x) * 4 + c]);
        const acc = [0, 0, 0, 0];
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            acc[0] = acc[1] = acc[2] = acc[3] = 0;
            for (let k = 0; k < taps.length; k++) {
                const sx = x + taps[k] * dx, sy = y + taps[k] * dy;
                const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy, wk = weights[k] / total;
                for (let c = 0; c < 4; c++) {
                    const v = (at(ix, iy, c) * (1 - fx) + at(ix + 1, iy, c) * fx) * (1 - fy) + (at(ix, iy + 1, c) * (1 - fx) + at(ix + 1, iy + 1, c) * fx) * fy;
                    acc[c] += v * wk;
                }
            }
            const i = (y * w + x) * 4;
            const a = Math.min(255, Math.max(0, Math.round(acc[3])));
            p[i + 3] = a;
            for (let c = 0; c < 3; c++) p[i + c] = Math.min(a, Math.max(0, Math.round(acc[c])));
        }
    }

    // The kernel for a resolved adjustment, in place on premultiplied pixels. `origin`: the region's document origin
    // (Grain and Add Noise are document-anchored, LayerAdjustment.swift:176-199).
    function runKernel(adj, p, w, h, origin = { x: 0, y: 0 }) {
        const r = resolved(adj);
        switch (adj.kind) {
            case 'Levels':
                if (levelsIdentity(r.levels)) return;
                return levelsApply(p, levelsTables(r.levels), 'L' + JSON.stringify(r.levels.ranges));
            case 'Curves': return levelsApply(p, curvesTables(r.curves), 'C' + JSON.stringify(r.curves.channels));
            case 'Exposure': return levelsApply(p, exposureTables(r.exposure), 'E' + JSON.stringify(r.exposure));
            case 'Invert': return invertApply(p);
            case 'Gradient Map': return gradientMapApply(p, gradientMapTable(r.gradientMap));
            case 'Black & White': return blackWhiteApply(p, r.blackWhite);
            case 'Color Balance': return colorBalanceApply(p, r.colorBalance);
            case 'Hue/Saturation': return cubeApply(p, hsCube(r.hsv));
            case 'Grain': return grainApply(p, w, h, r.grain, origin.x, origin.y, 1);
            case 'Add Noise': return addNoiseApply(p, w, h, r.noiseAmount, r.noiseGaussian, r.noiseMonochromatic, r.noiseSeed, Math.floor(origin.x), Math.floor(origin.y));
            case 'Motion Blur': return motionBlurApply(p, w, h, r.motionAngle, r.motionDistance);
            case 'Gaussian Blur': return gaussianApply(p, w, h, r.blurRadius);
            default: return undefined;
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Drawing an adjustment (LiveMaskRenderer.swift:39-87, adjustments-effects.md 2.8)

    // A non-Normal mode (2.4): colors blended at full coverage, both made opaque, then the original alpha restored.
    function blendAtFullCoverage(orig, out, w, h, mode) {
        const b = new ImageData(w, h), s = new ImageData(w, h);
        for (let i = 0; i < orig.length; i += 4) {
            const ao = orig[i + 3], at = out[i + 3];
            for (let c = 0; c < 3; c++) {
                b.data[i + c] = ao ? Math.min(255, Math.floor((orig[i + c] * 255 + (ao >> 1)) / ao)) : 0;
                s.data[i + c] = at ? Math.min(255, Math.floor((out[i + c] * 255 + (at >> 1)) / at)) : 0;
            }
            b.data[i + 3] = s.data[i + 3] = 255;
        }
        let blended;
        const op = CB.Blend.native(mode);
        if (op) {
            const base = new OffscreenCanvas(w, h), bctx = base.getContext('2d', { willReadFrequently: true });
            bctx.putImageData(b, 0, 0);
            const top = new OffscreenCanvas(w, h);
            top.getContext('2d').putImageData(s, 0, 0);
            bctx.globalCompositeOperation = op;
            bctx.drawImage(top, 0, 0);
            blended = bctx.getImageData(0, 0, w, h).data;
        } else {
            CB.Blend.blendPixels(b.data, s.data, mode, 1);
            blended = b.data;
        }
        const result = new Uint8Array(orig.length);
        for (let i = 0; i < orig.length; i += 4) {
            const a = orig[i + 3];
            for (let c = 0; c < 3; c++) result[i + c] = Math.floor((blended[i + c] * a + 127) / 255);
            result[i + 3] = a;
        }
        return result;
    }

    // The clip an adjustment is drawn back through (2.6): its own enabled mask stretched over its transform (placement
    // ignored, nothing outside that rect), times every ancestor folder's mask unless it is in a clipping stack. Null when
    // nothing clips.
    function adjustmentCoverage(renderer, record, info, region, inStack, docOrigin) {
        const live = renderer.overrides.get(record.id);
        const mask = record.maskFile && record.maskEnabled !== false && renderer.doc.entry(record.id).mask;
        const folders = inStack ? [] : info.ancestors(record).filter((f) => f.maskFile && f.maskEnabled !== false && renderer.doc.entry(f.id).mask);
        if (!mask && !(live && live.mask) && !folders.length) return null;
        const frame = { x: docOrigin.x + region.x, y: docOrigin.y + region.y, width: region.width, height: region.height };
        const surface = CB.Render.canvas2d(region.width, region.height);
        surface.ctx.fillStyle = '#000';
        surface.ctx.fillRect(0, 0, region.width, region.height);
        const transform = CB.Transform.read(record.transform, [renderer.doc.width, renderer.doc.height]);
        if (live && live.mask) renderer.applyOwnMask(surface.ctx, record, { transform }, frame);
        else if (mask) renderer.applyMask(surface.ctx, mask, transform, frame);
        if (!inStack) renderer.applyFolderMasks(surface.ctx, record, frame, info);
        const data = surface.ctx.getImageData(0, 0, region.width, region.height).data;
        const m = new Uint8Array(region.width * region.height);
        for (let i = 0; i < m.length; i++) m[i] = data[i * 4 + 3];
        return m;
    }

    // Runs `record`'s adjustment on `target` (a 2-D context of the document composite, or of a clipping stack's surface
    // whose pixel (0, 0) sits at `docOrigin` in the document). `region`: target pixels to adjust (default all).
    function drawAdjustment(renderer, target, record, info, { region, docOrigin = { x: 0, y: 0 }, inStack = false } = {}) {
        const canvas = target.canvas;
        const r = region || { x: 0, y: 0, width: canvas.width, height: canvas.height };
        if (r.width < 1 || r.height < 1) return;
        const adj = record.adjustment;
        const img = target.getImageData(r.x, r.y, r.width, r.height);
        const orig = toPremultiplied(new Uint8Array(img.data));
        let out = orig.slice();
        runKernel(adj, out, r.width, r.height, { x: docOrigin.x + r.x, y: docOrigin.y + r.y });
        const mode = renderer.blendOf(record);
        if (mode !== 'Normal') out = blendAtFullCoverage(orig, out, r.width, r.height, mode);
        // Opacity (2.5): a lerp on premultiplied bytes, alpha included, at the effective opacity.
        const o = info.opacityOf(record);
        if (o < 1) for (let i = 0; i < out.length; i++) out[i] = Math.round(orig[i] + (out[i] - orig[i]) * o);
        const m = adjustmentCoverage(renderer, record, info, r, inStack, docOrigin);
        if (m) {
            for (let px = 0, i = 0; px < m.length; px++, i += 4) {
                const k = m[px];
                if (k === 255) continue;
                for (let c = 0; c < 4; c++) out[i + c] = Math.round((out[i + c] * k + orig[i + c] * (255 - k)) / 255);
            }
        }
        toStraight(out, img.data);
        target.putImageData(img, r.x, r.y);
    }

    // Identity settings for the kinds that skip the whole step in export (Levels.swift:66, ImageAdjustments.swift:167,
    // 203): nothing to do unless a blend mode still blends the composite with itself.
    function changesNothing(adj, mode) {
        if (mode && mode !== 'Normal') return false;
        const r = resolved(adj);
        if (adj.kind === 'Levels') return levelsIdentity(r.levels);
        if (adj.kind === 'Color Balance') return COLOR_BALANCE_KEYS.every((k) => r.colorBalance[k] === 0);
        if (adj.kind === 'Grain') return !(r.grain.amount > 0);
        return false;
    }

    // Levels histogram (levels_histogram, LevelsPixels.c:17-28), for when the engine cannot measure it: per pixel with
    // alpha, weight alpha/255 x coverage/255, each channel's bin by its unpremultiplied value, RGB the mean of the three.
    function histogram(p, coverage) {
        const bins = [new Float64Array(256), new Float64Array(256), new Float64Array(256), new Float64Array(256)];
        for (let i = 0, px = 0; i < p.length; i += 4, px++) {
            const a = p[i + 3];
            if (!a) continue;
            const weight = (a / 255) * (coverage ? coverage[px] / 255 : 1);
            if (!weight) continue;
            for (let c = 0; c < 3; c++) {
                const v = Math.trunc(Math.min(255, Math.round((p[i + c] * 255) / a)));
                bins[c + 1][v] += weight;
                bins[0][v] += weight / 3;
            }
        }
        return bins.map((b) => Array.from(b));
    }

    // Row icons standing in for the kinds' SF Symbols (AdjustmentKind.symbol); Curves' is turned a quarter clockwise.
    const ICONS = {
        'Hue/Saturation': '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 0 0 17z" fill="currentColor"/>',
        Levels: '<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="8" cy="7" r="2" fill="currentColor"/><circle cx="15" cy="12" r="2" fill="currentColor"/><circle cx="10" cy="17" r="2" fill="currentColor"/>',
        Curves: '<circle cx="18.5" cy="5.5" r="2"/><circle cx="5.5" cy="18.5" r="2"/><path d="M7 17c3-2 2.5-7 5.5-9.5S16 7 17 7"/>',
        Exposure: '<circle cx="12" cy="12" r="8.5"/><path d="M8 9.5h4M10 7.5v4M12.5 15.5h4"/>',
        'Gradient Map': '<path d="M12 3.5c-4.7 0-8.5 3.4-8.5 7.7 0 3.6 2.9 5.3 5 5.3 1.6 0 2 1.1 2 2.2 0 1.3 1 2.3 2.4 1.9 4.2-1.1 7.6-4.4 7.6-9.4 0-4.3-3.8-7.7-8.5-7.7z"/><circle cx="8" cy="10" r="1.2" fill="currentColor"/><circle cx="12" cy="7.5" r="1.2" fill="currentColor"/><circle cx="16" cy="10" r="1.2" fill="currentColor"/>',
        Grain: '<circle cx="12" cy="12" r="8.5"/><circle cx="8.5" cy="8.5" r="1" fill="currentColor"/><circle cx="12" cy="8.5" r="1" fill="currentColor"/><circle cx="15.5" cy="8.5" r="1" fill="currentColor"/><circle cx="8.5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="15.5" cy="12" r="1" fill="currentColor"/><circle cx="8.5" cy="15.5" r="1" fill="currentColor"/><circle cx="12" cy="15.5" r="1" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1" fill="currentColor"/>',
        'Add Noise': '<circle cx="12" cy="12" r="8.5" stroke-dasharray="1.2 2.4"/>',
        'Gaussian Blur': '<path d="M12 3.5c3.3 4.2 6 7.6 6 10.6a6 6 0 0 1-12 0c0-3 2.7-6.4 6-10.6z" fill="currentColor"/>',
        'Motion Blur': '<path d="M3.5 9h11a3 3 0 1 0-3-3M3.5 13h15a3 3 0 1 1-3 3M3.5 17h6"/>',
        Invert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/>',
        'Black & White': '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M5 18l4-4M15 10l4-4M3.5 13l5-5"/>',
        'Color Balance': '<path d="M12 12V3.5M12 12l-7 4.5M12 12l7 4.5"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>',
    };
    const iconName = (kind) => `adjustment ${kind}`;
    if (CB.iconPaths) for (const [kind, path] of Object.entries(ICONS)) CB.iconPaths[iconName(kind)] = path;

    CB.Adjust = {
        iconName,
        KINDS, RANGES, DEFAULT_BANDS, FILTER_KIND, DEFAULTS, COLOR_BALANCE_KEYS, isEditable, resolved, resolvedHSV, hsvSettings,
        hsvToManifest, hsvIdentity, COLORIZE_START, normalizedRange, identityRange, defaultLevels, defaultCurves, levelsIdentity,
        curvesValid, isValid, samplingMargin, toPremultiplied, toStraight, rangeApply, levelsTables, levelsApply, curveValue,
        curvesTables, exposureTables, invertApply, gradientMapTable, gradientMapApply, blackWhiteApply, colorBalanceApply,
        bandWeight, hsWeight, hueResponse, hsCube, cubeApply, shiftedHue, toHSL, grainApply, addNoiseApply, motionBlurApply,
        runKernel, gaussianApply, blendAtFullCoverage, drawAdjustment, changesNothing, histogram, swiftRound, mix32,
    };
})();
