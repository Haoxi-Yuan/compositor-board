'use strict';
// Compositor's Camera Raw Filter on the board (upstream UI/CameraRawControls.swift, UI/CameraRawColorControls.swift,
// UI/CameraRawDetailOpticsControls.swift, UI/CameraRawGeometryCalibrationControls.swift, UI/CameraRawSlider.swift,
// Document/CameraRaw*.swift, Document/Filters.swift). The panel docks at the board's right edge; compositor-engine keeps
// the app's own filter edit open as a live session and renders every preview, scope, sample and commit. The board owns
// the panel state, sends its whole current state with one request in flight (the newest state wins, none is
// cancelled), and draws the view-sized preview tiles in place of the layer. Specification: docs/port-specs/camera-raw.md.

(function () {
    const CB = (window.CB = window.CB || {});
    const { Transform, Affine } = CB;

    // ---------------------------------------------------------------------------------------------------------------
    // Model (Document/CameraRaw.swift, CameraRawColor.swift, CameraRawDetailOptics.swift,
    // CameraRawGeometryCalibration.swift, CameraRawReset.swift; camera-raw.md 17 and 19.3)

    // Swift's .rounded(): half away from zero.
    const roundHalfAway = (v) => Math.sign(v) * Math.round(Math.abs(v));
    // ImageAdjustmentPixels.clamp: non-finite values fall back to the default.
    const clamp = (v, lo, hi, fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
    const linear = () => [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    const MEDIUM = [{ x: 0, y: 0 }, { x: 0.25, y: 0.18 }, { x: 0.75, y: 0.82 }, { x: 1, y: 1 }];
    const STRONG = [{ x: 0, y: 0 }, { x: 0.25, y: 0.10 }, { x: 0.75, y: 0.90 }, { x: 1, y: 1 }];
    const NAMES = ['Reds', 'Oranges', 'Yellows', 'Greens', 'Aquas', 'Blues', 'Purples', 'Magentas'];
    const CENTERS = [0, 30, 60, 120, 180, 240, 270, 300];
    const PROCESS = {
        'Version 1': 'Earliest response. Hue, saturation, and shadow tint move about half as far as Version 6.',
        'Version 2': 'A little stronger than Version 1. The sliders below still fall well short of the current look.',
        'Version 3': 'Firmer color than Version 2. Primary shifts stay gentler than the current process.',
        'Version 4': 'The 2012 response. Calibration reaches most of the strength used by Version 6.',
        'Version 5': 'Close to the current process, with slightly softer primary and shadow shifts.',
        'Version 6': 'Current default. The calibration sliders below apply at full strength.',
    };
    const wheel = () => ({ hue: 0, saturation: 0, luminance: 0 });

    // CameraRawSettings(): the identity grade (camera-raw.md 17.4).
    function defaults() {
        return {
            whiteBalance: 'Custom', temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0,
            blacks: 0, vibrance: 0, saturation: 0, texture: 0, clarity: 0, dehaze: 0, glow: 0, glowStyle: 'Diffusion',
            glowRange: 0, glowSpread: 0, glowWarmth: 0, vignetteAmount: 0, vignetteStyle: 'Highlight Priority',
            vignetteMidpoint: 50, vignetteRoundness: 0, vignetteFeather: 50, vignetteHighlights: 0, grainAmount: 0,
            grainSize: 25, grainRoughness: 50,
            curve: { shadows: 0, darks: 0, lights: 0, highlights: 0, shadowSplit: 25, darkSplit: 50, lightSplit: 75,
                rgb: linear(), red: linear(), green: linear(), blue: linear(), refineSaturation: 0 },
            mixer: { hue: [0, 0, 0, 0, 0, 0, 0, 0], saturation: [0, 0, 0, 0, 0, 0, 0, 0], luminance: [0, 0, 0, 0, 0, 0, 0, 0], points: [] },
            grading: { shadows: wheel(), midtones: wheel(), highlights: wheel(), global: wheel(), blending: 50, balance: 0 },
            detail: { sharpenAmount: 0, sharpenRadius: 10, sharpenDetail: 25, sharpenMasking: 0, noiseLuminance: 0,
                noiseLuminanceDetail: 50, noiseLuminanceContrast: 0, noiseColor: 0, noiseColorDetail: 50, noiseColorSmoothness: 50 },
            optics: { removeChromaticAberration: false, enableLensProfile: false, profileDistortion: 100, profileVignetting: 100,
                distortion: 0, purpleAmount: 0, purpleHueLow: 270, purpleHueHigh: 310, greenAmount: 0, greenHueLow: 60,
                greenHueHigh: 120, vignetteAmount: 0, vignetteMidpoint: 50 },
            geometry: { upright: 'Off', projection: 'Perspective', vertical: 0, horizontal: 0, rotate: 0, aspect: 0, scale: 0,
                offsetX: 0, offsetY: 0, constrainCrop: false, guides: [] },
            calibration: { process: 'Version 6', shadowTint: 0, redHue: 0, redSaturation: 0, greenHue: 0, greenSaturation: 0,
                blueHue: 0, blueSaturation: 0 },
        };
    }

    const clone = (value) => JSON.parse(JSON.stringify(value));

    // Settings laid over the defaults, key by key (an older or partial object keeps the defaults it lacks).
    function complete(given) {
        const base = defaults();
        const lay = (into, from) => {
            if (!from || typeof from !== 'object') return;
            for (const key of Object.keys(into)) {
                if (!(key in from)) continue;
                const value = from[key];
                if (into[key] && typeof into[key] === 'object' && !Array.isArray(into[key])) lay(into[key], value);
                else into[key] = clone(value);
            }
        };
        lay(base, given);
        return base;
    }

    // CameraRawCurveSettings.repair (CameraRawColor.swift:141-154).
    function repair(points) {
        const sorted = (Array.isArray(points) ? points : []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
            .map((p) => ({ x: p.x, y: p.y })).sort((a, b) => a.x - b.x);
        if (sorted.length < 2) return linear();
        const first = { x: 0, y: Math.min(1, Math.max(0, sorted[0].y)) };
        const last = { x: 1, y: Math.min(1, Math.max(0, sorted[sorted.length - 1].y)) };
        const kept = [first];
        for (const point of sorted.slice(1, -1)) {
            const x = Math.min(0.99, Math.max(0.01, point.x));
            if (!(x > kept[kept.length - 1].x + 0.01)) continue;
            kept.push({ x, y: Math.min(1, Math.max(0, point.y)) });
        }
        kept.push(last);
        return kept;
    }

    // CameraRawSettings.normalized and every nested struct's (camera-raw.md 17.2).
    function normalize(input) {
        const s = complete(input);
        const tone = (v) => clamp(v, -100, 100, 0);
        for (const key of ['contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temperature', 'tint', 'vibrance', 'saturation',
            'texture', 'clarity', 'dehaze', 'glowRange', 'glowSpread', 'glowWarmth', 'vignetteAmount', 'vignetteRoundness']) s[key] = tone(s[key]);
        s.exposure = clamp(s.exposure, -5, 5, 0);
        s.glow = clamp(s.glow, 0, 100, 0);
        s.vignetteMidpoint = clamp(s.vignetteMidpoint, 0, 100, 50);
        s.vignetteFeather = clamp(s.vignetteFeather, 0, 100, 50);
        s.vignetteHighlights = clamp(s.vignetteHighlights, 0, 100, 0);
        s.grainAmount = clamp(s.grainAmount, 0, 100, 0);
        s.grainSize = clamp(s.grainSize, 0, 100, 25);
        s.grainRoughness = clamp(s.grainRoughness, 0, 100, 50);
        const c = s.curve;
        for (const key of ['shadows', 'darks', 'lights', 'highlights', 'refineSaturation']) c[key] = tone(c[key]);
        c.shadowSplit = clamp(c.shadowSplit, 5, 90, 25);
        c.darkSplit = clamp(c.darkSplit, c.shadowSplit + 2, 95, 50);
        c.lightSplit = clamp(c.lightSplit, c.darkSplit + 2, 98, 75);
        for (const key of ['rgb', 'red', 'green', 'blue']) c[key] = repair(c[key]);
        const m = s.mixer;
        for (const key of ['hue', 'saturation', 'luminance']) m[key] = (m[key].length === 8 ? m[key] : [0, 0, 0, 0, 0, 0, 0, 0]).map(tone);
        m.points = (m.points || []).slice(0, 8).map((given) => {
            const p = { hue: 0, saturation: 0, luminance: 0, hueShift: 0, saturationShift: 0, luminanceShift: 0, hueRange: 30,
                saturationRange: 0.4, luminanceRange: 0.4, visualize: false, ...given };
            return {
                hue: clamp(p.hue, 0, 360, 0), saturation: clamp(p.saturation, 0, 1, 0), luminance: clamp(p.luminance, 0, 1, 0),
                hueShift: tone(p.hueShift), saturationShift: tone(p.saturationShift), luminanceShift: tone(p.luminanceShift),
                hueRange: clamp(p.hueRange, 5, 180, 30), saturationRange: clamp(p.saturationRange, 0.05, 1, 0.4),
                luminanceRange: clamp(p.luminanceRange, 0.05, 1, 0.4), visualize: Boolean(p.visualize),
            };
        });
        const g = s.grading;
        for (const key of ['shadows', 'midtones', 'highlights', 'global']) {
            g[key] = { hue: clamp(g[key].hue, 0, 360, 0), saturation: clamp(g[key].saturation, 0, 100, 0), luminance: tone(g[key].luminance) };
        }
        g.blending = clamp(g.blending, 0, 100, 50);
        g.balance = tone(g.balance);
        const d = s.detail;
        d.sharpenAmount = clamp(d.sharpenAmount, 0, 150, 0);
        const unit = { sharpenRadius: 10, sharpenDetail: 25, sharpenMasking: 0, noiseLuminance: 0, noiseLuminanceDetail: 50,
            noiseLuminanceContrast: 0, noiseColor: 0, noiseColorDetail: 50, noiseColorSmoothness: 50 };
        for (const [key, fallback] of Object.entries(unit)) d[key] = clamp(d[key], 0, 100, fallback);
        const o = s.optics;
        o.profileDistortion = clamp(o.profileDistortion, 0, 100, 100);
        o.profileVignetting = clamp(o.profileVignetting, 0, 100, 100);
        o.distortion = tone(o.distortion);
        o.purpleAmount = clamp(o.purpleAmount, 0, 100, 0);
        o.greenAmount = clamp(o.greenAmount, 0, 100, 0);
        o.vignetteAmount = tone(o.vignetteAmount);
        o.vignetteMidpoint = clamp(o.vignetteMidpoint, 0, 100, 50);
        o.purpleHueLow = clamp(o.purpleHueLow, 0, 360, 270);
        o.purpleHueHigh = clamp(o.purpleHueHigh, 0, 360, 310);
        o.greenHueLow = clamp(o.greenHueLow, 0, 360, 60);
        o.greenHueHigh = clamp(o.greenHueHigh, 0, 360, 120);
        if (o.purpleHueLow > o.purpleHueHigh) [o.purpleHueLow, o.purpleHueHigh] = [o.purpleHueHigh, o.purpleHueLow];
        if (o.greenHueLow > o.greenHueHigh) [o.greenHueLow, o.greenHueHigh] = [o.greenHueHigh, o.greenHueLow];
        o.removeChromaticAberration = Boolean(o.removeChromaticAberration);
        o.enableLensProfile = Boolean(o.enableLensProfile);
        const geo = s.geometry;
        for (const key of ['vertical', 'horizontal', 'aspect', 'scale', 'offsetX', 'offsetY']) geo[key] = tone(geo[key]);
        geo.rotate = clamp(geo.rotate, -45, 45, 0);
        geo.guides = (geo.guides || []).filter((q) => Math.hypot(q.endX - q.startX, q.endY - q.startY) > 0.01);
        const cal = s.calibration;
        for (const key of ['shadowTint', 'redHue', 'redSaturation', 'greenHue', 'greenSaturation', 'blueHue', 'blueSaturation']) cal[key] = tone(cal[key]);
        return s;
    }

    const isLinear = (p) => p.length === 2 && p[0].x === 0 && p[0].y === 0 && p[1].x === 1 && p[1].y === 1;
    const samePoints = (a, b) => a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y);

    // What each section's eye and reset follow (CameraRaw.swift:115-130 and the structs' `adjusts`).
    const ADJUSTS = {
        light: (s) => ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'].some((k) => s[k] !== 0),
        color: (s) => ['temperature', 'tint', 'vibrance', 'saturation'].some((k) => s[k] !== 0),
        effects: (s) => ['texture', 'clarity', 'dehaze', 'glow', 'vignetteAmount', 'grainAmount'].some((k) => s[k] !== 0),
        curve: (s) => ['shadows', 'darks', 'lights', 'highlights', 'refineSaturation'].some((k) => s.curve[k] !== 0)
            || ['rgb', 'red', 'green', 'blue'].some((k) => !isLinear(s.curve[k])),
        colorMixer: (s) => ['hue', 'saturation', 'luminance'].some((k) => s.mixer[k].some((v) => v !== 0))
            || s.mixer.points.some((p) => p.hueShift !== 0 || p.saturationShift !== 0 || p.luminanceShift !== 0),
        colorGrading: (s) => ['shadows', 'midtones', 'highlights', 'global'].some((k) => s.grading[k].saturation !== 0 || s.grading[k].luminance !== 0),
        detail: (s) => s.detail.sharpenAmount !== 0 || s.detail.noiseLuminance !== 0 || s.detail.noiseColor !== 0,
        optics: (s) => s.optics.removeChromaticAberration || s.optics.enableLensProfile || s.optics.distortion !== 0
            || s.optics.purpleAmount !== 0 || s.optics.greenAmount !== 0 || s.optics.vignetteAmount !== 0,
        geometry: (s) => (s.geometry.upright === 'Guided' && s.geometry.guides.some((q) => Math.hypot(q.endX - q.startX, q.endY - q.startY) > 0.01))
            || ['vertical', 'horizontal', 'rotate', 'aspect', 'scale', 'offsetX', 'offsetY'].some((k) => s.geometry[k] !== 0),
        calibration: (s) => ['shadowTint', 'redHue', 'redSaturation', 'greenHue', 'greenSaturation', 'blueHue', 'blueSaturation'].some((k) => s.calibration[k] !== 0),
    };
    const isIdentity = (s) => Object.values(ADJUSTS).every((adjusts) => !adjusts(s));

    // CameraRawSettings.resetting(group) (CameraRawReset.swift:35-76): the group's fields back to the defaults.
    const RESET_FIELDS = {
        light: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'],
        color: ['whiteBalance', 'temperature', 'tint', 'vibrance', 'saturation'],
        effects: ['texture', 'clarity', 'dehaze', 'glow', 'glowStyle', 'glowRange', 'glowSpread', 'glowWarmth', 'vignetteAmount',
            'vignetteStyle', 'vignetteMidpoint', 'vignetteRoundness', 'vignetteFeather', 'vignetteHighlights', 'grainAmount',
            'grainSize', 'grainRoughness'],
        curve: ['curve'], colorMixer: ['mixer'], colorGrading: ['grading'], detail: ['detail'], optics: ['optics'],
        geometry: ['geometry'], calibration: ['calibration'],
    };
    function resetting(s, group) {
        const result = clone(s), base = defaults();
        for (const key of RESET_FIELDS[group]) result[key] = clone(base[key]);
        return result;
    }

    // CurvesSettings.value (Document/Curves.swift:18-31): monotone cubic Hermite through points in 0…255.
    function curveValue(p, x) {
        const n = p.length;
        let i = 0;
        for (let k = 0; k < n; k++) if (p[k].x <= x) i = k;
        i = Math.min(n - 2, Math.max(0, i));
        const d = [];
        for (let k = 0; k < n - 1; k++) d.push((p[k + 1].y - p[k].y) / (p[k + 1].x - p[k].x));
        const slope = (j) => {
            if (j === 0) return d[0];
            if (j === n - 1) return d[d.length - 1];
            if (d[j - 1] * d[j] <= 0) return 0;
            return 2 / (1 / d[j - 1] + 1 / d[j]);
        };
        const h = p[i + 1].x - p[i].x, t = Math.min(1, Math.max(0, (x - p[i].x) / h));
        const y = (2 * t * t * t - 3 * t * t + 1) * p[i].y + (t * t * t - 2 * t * t + t) * h * slope(i)
            + (-2 * t * t * t + 3 * t * t) * p[i + 1].y + (t * t * t - t * t) * h * slope(i + 1);
        return Math.min(255, Math.max(0, y));
    }

    // CameraRawCurveSettings.point: a 0…1 point list through the 0…255 spline.
    function pointValue(x, points) {
        if (points.length < 2) return x;
        return curveValue(points.map((q) => ({ x: q.x * 255, y: q.y * 255 })), x * 255) / 255;
    }

    const channelTable = (points) => Array.from({ length: 256 }, (_, i) => pointValue(i / 255, points));

    // The parametric bend (CameraRawColor.swift:66-79), strength 1.66.
    function bend(tone, lower, low, upper, high) {
        const strength = 1.66;
        if (tone < lower && lower > 0) return lower * Math.pow(tone / lower, Math.pow(2, (-low / 100) * strength));
        if (tone > upper && upper < 1) {
            const rest = 1 - upper;
            return 1 - rest * Math.pow((1 - tone) / rest, Math.pow(2, (high / 100) * strength));
        }
        return tone;
    }

    // CameraRawCurveSettings.parametric (CameraRawColor.swift:52-64), which the graph draws.
    function parametric(c, tone) {
        if (c.shadows === 0 && c.darks === 0 && c.lights === 0 && c.highlights === 0) return tone;
        const anchors = [];
        for (let i = 0; i <= 32; i++) {
            const x = i / 32;
            anchors.push({ x, y: bend(bend(x, c.shadowSplit / 100, c.shadows, c.lightSplit / 100, c.highlights), c.darkSplit / 100, c.darks, c.darkSplit / 100, c.lights) });
        }
        return pointValue(tone, anchors);
    }

    // region(for:) (CameraRawColor.swift:108-114).
    function region(c, tone) {
        if (tone < c.shadowSplit / 100) return 'shadows';
        if (tone < c.darkSplit / 100) return 'darks';
        if (tone < c.lightSplit / 100) return 'lights';
        return 'highlights';
    }

    // nudged(_:near:by:) (CameraRawColor.swift:84-104): the point nearest in x, the ends included.
    function nudged(c, channel, tone, delta) {
        const result = clone(c), points = result[channel];
        let index = 0;
        points.forEach((p, i) => { if (Math.abs(p.x - tone) < Math.abs(points[index].x - tone)) index = i; });
        points[index].y = Math.min(1, Math.max(0, points[index].y + delta));
        return result;
    }

    // CameraRawMixerSettings.weights(forHue:) (CameraRawColor.swift:172-178).
    const weights = (degrees) => CENTERS.map((center) => {
        let distance = Math.abs(degrees - center);
        if (distance > 180) distance = 360 - distance;
        return Math.max(0, 1 - distance / 40);
    });

    // ---------------------------------------------------------------------------------------------------------------
    // Colors (CameraRawSliderTrack, UI/CameraRawSlider.swift:21-49)

    function hsv(degrees, s, v) {
        let h = degrees / 360;
        h -= Math.floor(h);
        const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
        return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
    }
    const css = (rgb, alpha = 1) => `rgba(${rgb.map((c) => Math.round(c * 255)).join(',')},${alpha})`;
    const TRACKS = {
        temperature: () => [[0.22, 0.46, 0.95], [0.98, 0.82, 0.18]],
        tint: () => [[0.28, 0.70, 0.34], [0.70, 0.40, 0.64]],
        chroma: () => [[0.62, 0.62, 0.64], [0.86, 0.18, 0.20]],
        hue: (d) => [hsv(d - 50, 0.85, 0.9), hsv(d + 50, 0.85, 0.9)],
        saturation: (d) => [[0.55, 0.55, 0.56], hsv(d, 0.9, 0.9)],
        luminance: (d) => [hsv(d, 0.55, 0.18), hsv(d, 0.35, 0.95)],
    };
    // SwiftUI's red, green and blue in the app's dark appearance.
    const SYSTEM = { red: [1, 69 / 255, 58 / 255], green: [48 / 255, 209 / 255, 88 / 255], blue: [10 / 255, 132 / 255, 1] };

    const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    // `.number.precision(.fractionLength(0...decimals))`: up to `decimals` digits, no trailing zeros.
    const formatted = (value, decimals) => {
        const text = String(Number(roundHalfAway(value * 10 ** decimals) / 10 ** decimals));
        return text === '-0' ? '0' : text;
    };

    function h(tag, props = {}, ...children) {
        const el = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (value === undefined || value === null || value === false) continue;
            if (key === 'class') el.className = value;
            else if (key === 'style') el.style.cssText = value;
            else if (key === 'html') el.innerHTML = value;
            else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
            else el.setAttribute(key, value === true ? '' : value);
        }
        for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(child.nodeType ? child : String(child));
        return el;
    }

    const ICONS = {
        eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
        eyeSlash: '<path d="M3 3l18 18M10.6 5.6A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.4 6.4C3.9 8.1 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9.4 9.4 0 0 0 5.2-1.6M9.9 9.9a2.8 2.8 0 0 0 4 4"/>',
        reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/>',
        chevronDown: '<path d="M5 9l7 7 7-7"/>',
        chevronRight: '<path d="M9 5l7 7-7 7"/>',
        eyedropper: '<path d="M14.5 4.5a2.8 2.8 0 0 1 4 4l-2 2-4-4z"/><path d="M12.5 6.5l5 5M13.8 10.2l-7.6 7.6-2.7.7.7-2.7 7.6-7.6"/>',
        scope: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>',
        diagonal: '<path d="M5 19L19 5"/>',
        triangle: '<path d="M12 4l9 16H3z" fill="currentColor" stroke="none"/>',
        close: '<path d="M6 6l12 12M18 6L6 18"/>',
    };
    const svg = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

    // ---------------------------------------------------------------------------------------------------------------
    // The slider (CameraRawSliderView, UI/CameraRawSlider.swift:120-206; camera-raw.md 5.1)

    const KNOB = 14;

    class CRSlider {
        // o: { min, max, get(), slide(value, event) for drags and track clicks, reset(), track() -> [left, right] | null,
        //      help, width, disabled() }
        constructor(panel, o) {
            this.panel = panel;
            this.o = o;
            this.el = h('div', { class: 'craw-slider', role: 'slider', title: o.help, 'aria-label': o.help, style: o.width ? `width:${o.width}px;flex:none` : '' },
                h('div', { class: 'craw-track' }, h('div', { class: 'craw-fill' })), h('div', { class: 'craw-knob' }));
            this.track = this.el.querySelector('.craw-track');
            this.fill = this.el.querySelector('.craw-fill');
            this.knob = this.el.querySelector('.craw-knob');
            this.el.addEventListener('pointerdown', (e) => this.down(e));
            // "Knob double-click resets": the knob frame grown by 2 points each side.
            this.el.addEventListener('dblclick', (e) => { if (this.onKnob(e)) o.reset(); });
        }

        fraction(value) {
            const { min, max } = this.o;
            return max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
        }

        onKnob(e) {
            const r = this.knob.getBoundingClientRect();
            return e.clientX >= r.left - 2 && e.clientX <= r.right + 2 && e.clientY >= r.top - 2 && e.clientY <= r.bottom + 2;
        }

        down(e) {
            if (e.button !== 0 || (this.o.disabled && this.o.disabled()) || (this.panel.state && this.panel.state.committing)) return;
            // The press focuses the webview as any click does (VS Code routes ⌘Z and the ⌥ release by it); the keys then
            // go to the panel.
            if (this.panel.el) this.panel.el.focus({ preventScroll: true });
            const rect = this.el.getBoundingClientRect(), { min, max } = this.o;
            const span = Math.max(1, rect.width - KNOB);
            this.el.setPointerCapture(e.pointerId);
            this.panel.dragging++;
            if (this.onKnob(e)) {
                // The system tracking loop: the value follows the pointer from where the knob was grabbed.
                const grab = e.clientX - this.knob.getBoundingClientRect().left;
                this.el.onpointermove = (m) => {
                    const f = Math.min(1, Math.max(0, (m.clientX - grab - rect.left) / span));
                    this.o.slide(min + f * (max - min), m);
                };
            } else {
                // "Track click glides": the value under the press, published once; the knob glides there; moving before
                // release changes nothing (CameraRawSlider.swift:139-171).
                const f = Math.min(1, Math.max(0, (e.clientX - rect.left - KNOB / 2) / span));
                this.el.classList.add('gliding');
                this.o.slide(min + f * (max - min), e);
                setTimeout(() => this.el.classList.remove('gliding'), 200);
                this.el.onpointermove = null;
            }
            this.el.onpointerup = this.el.onpointercancel = () => {
                this.el.onpointermove = this.el.onpointerup = this.el.onpointercancel = null;
                this.panel.dragging = Math.max(0, this.panel.dragging - 1);
                this.panel.refresh();
            };
        }

        update() {
            const value = this.o.get(), f = this.fraction(value);
            this.knob.style.left = `calc(${f} * (100% - ${KNOB}px))`;
            const colors = this.o.track ? this.o.track() : null;
            if (colors) {
                // "Gradient tracks": the colors across the whole bar instead of the accent fill.
                this.track.style.background = `linear-gradient(to right, ${css(colors[0])}, ${css(colors[1])})`;
                this.fill.style.display = 'none';
            } else {
                this.track.style.background = '';
                this.fill.style.display = '';
                this.fill.style.width = `calc(${f} * (100% - ${KNOB}px) + ${KNOB / 2}px)`;
            }
            const disabled = Boolean(this.o.disabled && this.o.disabled());
            this.el.classList.toggle('disabled', disabled);
            this.el.setAttribute('aria-valuenow', String(value));
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The panel

    const SECTIONS = [
        { id: 'light', title: 'Light' }, { id: 'color', title: 'Color' }, { id: 'colorGrading', title: 'Color Grading' },
        { id: 'effects', title: 'Effects' }, { id: 'curve', title: 'Curve' }, { id: 'colorMixer', title: 'Color Mixer' },
        { id: 'detail', title: 'Detail' }, { id: 'optics', title: 'Optics' }, { id: 'geometry', title: 'Geometry' },
        { id: 'calibration', title: 'Calibration' },
    ];
    const LABEL = 96;
    const allEyes = () => Object.fromEntries(SECTIONS.map((s) => [s.id, true]));

    class CameraRawPanel {
        constructor(board) {
            this.board = board;
            this.state = null;
            // filterSettings for Camera Raw: the rendered grade of the last OK, for the next open (Filters.swift:872-875).
            this.remembered = null;
            this.dragging = 0;
            this.alt = false;
            // ⌥ released: the clipping view and the sharpen-mask view end (installOptionMonitor, CameraRawControls.swift:394-407).
            const modifiers = (e) => {
                const alt = Boolean(e.altKey);
                if (this.alt && !alt) this.optionReleased();
                this.alt = alt;
            };
            window.addEventListener('keydown', modifiers, true);
            window.addEventListener('keyup', modifiers, true);
            window.addEventListener('pointermove', modifiers, true);
            window.addEventListener('pointerdown', modifiers, true);
            window.addEventListener('blur', () => { if (this.alt) this.optionReleased(); this.alt = false; });
        }

        get isOpen() {
            return Boolean(this.state);
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Opening, OK, Cancel (Filters.swift beginFilter, commitFilter, cancelFilter; camera-raw.md 2 and 18.6)

        async open() {
            const board = this.board;
            if (this.state || !board.filters.canAdjustColors()) { CB.beep(); return; }
            if (board.selectTools.floating) await board.selectTools.commitFloating();
            await board.resolvePending('edit');
            const record = board.activeLayer();
            const image = record && board.doc.entry(record.id).image;
            if (!record || !image || !board.filters.canAdjustColors()) { CB.beep(); return; }
            const transform = Transform.read(record.transform, [board.doc.width, board.doc.height]);
            this.state = {
                session: null, layerID: record.id, size: [image.width, image.height], transform,
                settings: normalize(this.remembered || defaults()), eyes: allEyes(), preview: true,
                overlay: { clipping: null, sharpenMask: false, shadowClipping: false, highlightClipping: false },
                pointIndex: 0, expanded: new Set(['light', 'color', 'colorGrading']), scopeMode: 'histogram', scope: null,
                readout: null, error: null, committing: false, curvePage: 'Parametric', pointChannel: 'rgb', curveSelected: null,
                mixerPage: 'HSL', mixerTab: 'hue', mixerSwatch: 0, gradePage: 'Three-Way',
                armed: { whiteBalance: false, pointColor: false, defringe: false, guides: false, curveTarget: false, mixerTarget: false },
                limited: Boolean(board.selection),
            };
            this.pump = { inFlight: false, dirty: false, actions: [], viewDirty: false, readoutAt: null, readoutSent: null, dragSample: null, serial: 0 };
            this.guideDraft = null;
            this.targetDrag = null;
            this.build();
            this.startWork(record, image);
            this.attachCanvas();
            board.changed();
            board.menuBar.close();
            this.refresh();
            await this.connect(false);
        }

        // filter.session.open: the engine begins the app's own edit with these settings and keeps it (18.3).
        async connect(retry) {
            const board = this.board, state = this.state;
            if (!state) return;
            this.pump.inFlight = true;
            let answer;
            try {
                answer = await board.engine('filter.session.open', {
                    activeLayerID: state.layerID, settings: state.settings, eyes: state.eyes, preview: state.preview,
                    overlay: { ...state.overlay, pointIndex: state.pointIndex }, view: this.view(), selection: board.selection,
                    foreground: board.colors.fg, background: board.colors.bg,
                }, { files: { out: 'rgba' }, quiet: true });
            } catch (error) {
                answer = { error: error.message, files: {} };
            }
            this.pump.inFlight = false;
            if (this.state !== state) {
                if (answer.session) board.engine('filter.session.close', { session: answer.session }, { stateless: true, quiet: true }).catch(() => {});
                return;
            }
            if (!answer.session) {
                // beginFilter refused (the layer can't take it) or failed: the panel goes and the reason shows as the
                // app's brush error does.
                this.finish();
                if (answer.error) board.alert('Couldn’t paint', answer.error);
                else CB.beep();
                return;
            }
            state.session = answer.session;
            state.size = answer.size || state.size;
            this.applyAnswer(answer);
            if (retry) this.pump.dirty = true;
            this.run();
        }

        // OK (commitFilter): the latest state, after any request in flight; the preview stays until the result is on
        // the layer (the extension pushes it before answering).
        async ok() {
            const board = this.board, state = this.state;
            if (!state || state.committing) return;
            state.committing = true;
            this.refresh();
            while (this.pump.inFlight) await new Promise((resolve) => setTimeout(resolve, 15));
            if (this.state !== state) return;
            if (!state.session) await this.connect(false);
            if (this.state !== state || !state.session) return;
            let answer;
            try {
                answer = await board.engine('filter.session.commit', { session: state.session, settings: state.settings, eyes: state.eyes },
                    { stateless: true, label: 'Camera Raw Filter' });
            } catch (error) {
                answer = { error: error.message };
            }
            if (this.state !== state) return;
            if (answer.unknownSession) {
                // The engine restarted: open again with this state and OK again.
                state.session = null;
                state.committing = false;
                await this.connect(false);
                return this.ok();
            }
            if (answer.stale) {
                // The project changed on disk meanwhile: the engine dropped the edit; open again on the project as it is
                // now, keeping the panel, and ask for OK again (camera-raw.md 18.7).
                state.session = null;
                state.committing = false;
                state.error = answer.error;
                this.resetWork();
                this.refresh();
                await this.connect(false);
                return;
            }
            if (answer.rendered) this.remembered = normalize(answer.rendered);
            if (answer.lastFilter) board.filters.lastFilter = answer.lastFilter;
            state.session = null;
            this.finish();
            if (answer.error) board.toast(answer.error);
        }

        // Cancel (button, Esc, the close box): the panel goes at once, nothing is remembered.
        cancel() {
            const state = this.state;
            if (!state || state.committing) return false;
            const session = state.session;
            this.finish();
            if (session) this.board.engine('filter.session.close', { session }, { stateless: true, quiet: true }).catch(() => {});
            return true;
        }

        // Last Filter after Camera Raw (repeatLastFilter): the remembered grade again, without the panel.
        async repeat() {
            const board = this.board;
            if (!board.filters.canAdjustColors()) { CB.beep(); return; }
            if (board.selectTools.floating) await board.selectTools.commitFloating();
            await board.resolvePending('edit');
            await board.selectionOp('filter.session.repeat', { settings: this.remembered || defaults() }, 'Camera Raw Filter');
        }

        finish() {
            const board = this.board, state = this.state;
            if (!state) return;
            this.state = null;
            this.detachCanvas();
            board.renderer.overrides.delete(state.layerID);
            if (this.el && this.el.isConnected) this.el.remove();
            if (board.openPanel === this.el) { board.openPanel = null; board.panelCancel = null; }
            clearInterval(this.watch);
            this.el = null;
            board.changed();
            board.view.cursor();
            board.focusCanvas();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Preview: the work canvas the layer is drawn from while the panel is open (camera-raw.md 18.5)

        startWork(record, image) {
            const [w, h2] = this.state.size;
            const work = new OffscreenCanvas(w, h2);
            this.work = { canvas: work, ctx: work.getContext('2d') };
            this.work.ctx.drawImage(image, 0, 0);
            this.showWork();
        }

        resetWork() {
            const state = this.state, image = state && this.board.doc.entry(state.layerID).image;
            if (!image) return;
            this.work.ctx.clearRect(0, 0, this.work.canvas.width, this.work.canvas.height);
            this.work.ctx.drawImage(image, 0, 0);
        }

        showWork() {
            const state = this.state, [w, h2] = state.size;
            if (state.preview) {
                this.board.renderer.overrides.set(state.layerID, {
                    canvas: this.work.canvas, toDocument: Transform.pixelToDocument(state.transform, w, h2), transform: state.transform,
                });
            } else this.board.renderer.overrides.delete(state.layerID);
            this.board.liveChanged();
        }

        // The part of the layer's pixel grid on screen, grown by 32 px, at display resolution.
        view() {
            const state = this.state, v = this.board.view;
            const [w, h2] = state.size;
            const M = Transform.pixelToDocument(state.transform, w, h2);
            const a = v.toDoc({ x: 0, y: 0 }), b = v.toDoc({ x: v.stage.clientWidth, y: v.stage.clientHeight });
            const box = Affine.boundsOf(Affine.invert(M), { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) });
            const x0 = Math.max(0, Math.floor(box.x - 32)), y0 = Math.max(0, Math.floor(box.y - 32));
            const x1 = Math.min(w, Math.ceil(box.x + box.width + 32)), y1 = Math.min(h2, Math.ceil(box.y + box.height + 32));
            const perPixel = Math.max(Math.hypot(M.a, M.b), Math.hypot(M.c, M.d));
            if (x1 <= x0 || y1 <= y0) return { x: 0, y: 0, width: 1, height: 1, scale: 1 };
            return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, scale: Math.min(1, v.zoom * perPixel) };
        }

        drawTile(tile, bytes) {
            if (!tile || !bytes || !bytes.length || !this.work) return;
            const data = new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, tile.pixelWidth * tile.pixelHeight * 4), tile.pixelWidth, tile.pixelHeight);
            const ctx = this.work.ctx;
            ctx.clearRect(tile.x, tile.y, tile.width, tile.height);
            if (tile.pixelWidth === tile.width && tile.pixelHeight === tile.height) ctx.putImageData(data, tile.x, tile.y);
            else {
                const piece = new OffscreenCanvas(tile.pixelWidth, tile.pixelHeight);
                piece.getContext('2d').putImageData(data, 0, 0);
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(piece, 0, 0, tile.pixelWidth, tile.pixelHeight, tile.x, tile.y, tile.width, tile.height);
            }
            this.board.liveChanged();
        }

        applyAnswer(answer) {
            const state = this.state;
            if (answer.scope) state.scope = answer.scope;
            state.error = answer.error || null;
            if (answer.alert) this.board.toast(answer.alert);
            if (answer.rendered && answer.tile) this.drawTile(answer.tile, answer.files && answer.files.out);
            this.refresh();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // The request pump (camera-raw.md 18.4): one request in flight; the whole current state each time, so the
        // newest state renders next and nothing is cancelled mid-render.

        changed() {
            if (!this.state) return;
            this.pump.dirty = true;
            this.refresh();
            this.run();
        }

        async run() {
            const p = this.pump, state = this.state, board = this.board;
            if (!state || p.inFlight || !state.session || state.committing) return;
            const session = state.session;
            const send = async (op, args, files) => {
                p.inFlight = true;
                let answer;
                try {
                    answer = await board.engine(op, { session, ...args }, { stateless: true, quiet: true, files });
                } catch (error) {
                    answer = { error: error.message, files: {}, failed: true };
                }
                p.inFlight = false;
                if (this.state !== state || state.session !== session) return null;
                if (answer.unknownSession || (answer.failed && /stopped/.test(answer.error))) {
                    // The engine restarted or lost the session: open again with the current state (18.8).
                    state.session = null;
                    await this.connect(true);
                    return null;
                }
                return answer;
            };
            if (p.dragSample) {
                const pending = p.dragSample;
                p.dragSample = null;
                const answer = await send('filter.session.sample', { point: [pending.point.x, pending.point.y] });
                if (answer && answer.sample) {
                    this.targetDrag = { startY: pending.point.y, settings: pending.settings, tone: answer.sample.tone, hue: answer.sample.hue, kind: pending.kind };
                    if (pending.lastY !== undefined && pending.lastY !== pending.point.y) this.dragTarget(pending.lastY);
                }
            } else if (p.actions.length || p.dirty) {
                const action = p.actions.shift() || null;
                p.dirty = false;
                const serial = ++p.serial;
                const answer = await send('filter.session.update', {
                    serial, settings: state.settings, eyes: state.eyes, preview: state.preview,
                    overlay: { ...state.overlay, pointIndex: state.pointIndex }, action, view: this.view(),
                }, { out: 'rgba' });
                if (answer && answer.serial === serial) {
                    if (answer.patch) {
                        // An action's result joins the local state; Auto's balance only while Auto is still chosen.
                        if (!(action && action.kind === 'autoWhiteBalance' && state.settings.whiteBalance !== 'Auto')) {
                            state.settings = normalize(merge(state.settings, answer.patch));
                        }
                    }
                    if (typeof answer.pointIndex === 'number') state.pointIndex = answer.pointIndex;
                    if (!state.preview) this.board.renderer.overrides.delete(state.layerID);
                    this.applyAnswer(answer);
                }
            } else if (p.viewDirty) {
                p.viewDirty = false;
                const answer = await send('filter.session.fetch', { view: this.view() }, { out: 'rgba' });
                if (answer && answer.tile) this.drawTile(answer.tile, answer.files && answer.files.out);
            } else if (p.readoutAt !== p.readoutSent) {
                const at = p.readoutAt;
                p.readoutSent = at;
                if (at) {
                    const answer = await send('filter.session.sample', { point: [at.x, at.y] });
                    if (answer) { state.readout = answer.readout; this.refreshReadout(); }
                } else {
                    state.readout = null;
                    this.refreshReadout();
                }
            } else return;
            this.run();
        }

        // ⌥ let go: the clipping and sharpen-mask views end and the preview renders without them.
        optionReleased() {
            const state = this.state;
            if (!state || (!state.overlay.clipping && !state.overlay.sharpenMask)) return;
            state.overlay.clipping = null;
            state.overlay.sharpenMask = false;
            this.changed();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Canvas tools while the panel is open (EditorCanvas.swift:1747-1776, 1866-1873, 2093-2097; camera-raw.md 2.1)

        attachCanvas() {
            const stage = this.board.view.stage;
            this.listeners = [
                ['pointerdown', (e) => this.canvasDown(e), true],
                ['pointermove', (e) => this.canvasMove(e), true],
                ['pointerup', (e) => this.canvasUp(e), true],
                ['pointercancel', (e) => this.canvasUp(e, true), true],
                ['pointermove', () => this.canvasCursor(), false],
                ['pointerleave', () => { if (this.state) { this.pump.readoutAt = null; this.run(); } }, false],
            ];
            for (const [type, fn, capture] of this.listeners) stage.addEventListener(type, fn, capture);
            // Pans and zooms bring the part of the preview newly on screen (debounced, only while idle); the panel also
            // notices when the board closed it itself (loading another project).
            this.lastView = null;
            this.watch = setInterval(() => this.watchView(), 120);
        }

        detachCanvas() {
            const stage = this.board.view.stage;
            for (const [type, fn, capture] of this.listeners || []) stage.removeEventListener(type, fn, capture);
            this.listeners = null;
            clearInterval(this.watch);
        }

        watchView() {
            const state = this.state, board = this.board;
            if (!state) return;
            if (!this.el || !this.el.isConnected || board.openPanel !== this.el) {
                // Closed by the board (another project loaded, another panel opened): as Cancel.
                const session = state.session;
                this.finish();
                if (session) board.engine('filter.session.close', { session }, { stateless: true, quiet: true }).catch(() => {});
                return;
            }
            const v = board.view;
            const key = [v.zoom, v.pan.x, v.pan.y, v.stage.clientWidth, v.stage.clientHeight].join(',');
            if (key !== this.lastView) {
                this.lastView = key;
                this.viewChangedAt = performance.now();
                this.viewPending = true;
            } else if (this.viewPending && performance.now() - this.viewChangedAt >= 100) {
                this.viewPending = false;
                this.pump.viewDirty = true;
                this.run();
            }
        }

        docPoint(e) {
            const v = this.board.view, r = v.stage.getBoundingClientRect();
            return v.toDoc({ x: e.clientX - r.left, y: e.clientY - r.top });
        }

        picking() {
            const a = this.state && this.state.armed;
            return Boolean(a && (a.whiteBalance || a.pointColor || a.defringe || a.guides));
        }

        canvasCursor() {
            if (this.state && this.picking() && !this.board.view.space) this.board.view.stage.style.cursor = CB.SelectionCursors.eyedropper('Sample');
        }

        canvasDown(e) {
            const state = this.state, board = this.board;
            if (!state || e.button !== 0 || board.view.space || state.committing) return;
            const a = state.armed, doc = this.docPoint(e);
            const take = () => { e.stopPropagation(); board.view.stage.focus(); };
            // The first armed tool in this order takes the click.
            if (a.whiteBalance || a.pointColor || a.defringe) {
                const kind = a.whiteBalance ? 'whiteBalance' : a.pointColor ? 'pointColor' : 'defringe';
                take();
                this.pump.actions.push({ kind, point: [doc.x, doc.y] });
                this.run();
                return;
            }
            if (a.guides) {
                take();
                const n = this.normalizedPoint(doc);
                if (n) {
                    this.guideDraft = { start: n, end: n };
                    board.view.stage.setPointerCapture(e.pointerId);
                }
                return;
            }
            if (a.curveTarget || a.mixerTarget) {
                take();
                board.view.stage.setPointerCapture(e.pointerId);
                // beginCameraRawDrag: the preview pixel under the press decides tone and hue; the settings at the press are
                // what each move starts from.
                this.targetDrag = null;
                this.pump.dragSample = { point: doc, settings: clone(state.settings), kind: a.curveTarget ? 'curve' : 'mixer' };
                this.pressing = true;
                this.run();
            }
        }

        canvasMove(e) {
            const state = this.state;
            if (!state) return;
            const doc = this.docPoint(e);
            if (this.guideDraft) {
                e.stopPropagation();
                const n = this.normalizedPoint(doc);
                if (n) this.guideDraft.end = n;
                return;
            }
            if (this.pressing) {
                e.stopPropagation();
                if (this.targetDrag) this.dragTarget(doc.y);
                else if (this.pump.dragSample) this.pump.dragSample.lastY = doc.y;
                return;
            }
            // mouseMoved: the readout follows the pointer over the canvas.
            if (e.buttons === 0) { this.pump.readoutAt = doc; this.run(); }
        }

        canvasUp(e, cancelled) {
            const state = this.state;
            if (!state) return;
            if (this.guideDraft) {
                e.stopPropagation();
                const draft = this.guideDraft;
                this.guideDraft = null;
                if (cancelled) return;
                // commitCameraRawGeometryGuide: appended, and Upright becomes Guided (a zero-length line is dropped by
                // normalization).
                const s = clone(state.settings);
                s.geometry.guides.push({ startX: draft.start.x, startY: draft.start.y, endX: draft.end.x, endY: draft.end.y });
                s.geometry.upright = 'Guided';
                state.settings = normalize(s);
                this.changed();
                return;
            }
            if (this.pressing) {
                e.stopPropagation();
                this.pressing = false;
                this.targetDrag = null;
                if (this.pump.dragSample) this.pump.dragSample = null;
            }
        }

        // cameraRawNormalizedPoint: layer pixels over the layer's size, top-left origin; nil outside the grid.
        normalizedPoint(doc) {
            const [w, h2] = this.state.size;
            const p = Affine.apply(Affine.invert(Transform.pixelToDocument(this.state.transform, w, h2)), doc.x, doc.y);
            if (p.x < 0 || p.y < 0 || p.x >= w || p.y >= h2) return null;
            return { x: p.x / w, y: p.y / h2 };
        }

        // dragCameraRaw (CameraRaw.swift:532-558): 0.35 per document pixel, from the settings at the press.
        dragTarget(y) {
            const state = this.state, drag = this.targetDrag;
            if (!state || !drag) return;
            const delta = (drag.startY - y) * 0.35;
            const s = clone(drag.settings);
            if (drag.kind === 'curve') {
                if (state.curvePage === 'Parametric') {
                    const key = region(drag.settings.curve, drag.tone);
                    s.curve[key] = Math.min(100, Math.max(-100, drag.settings.curve[key] + delta));
                } else s.curve = nudged(drag.settings.curve, state.pointChannel, drag.tone, delta / 100);
            } else {
                const w = weights(drag.hue), key = state.mixerTab;
                w.forEach((weight, i) => { if (weight > 0) s.mixer[key][i] = Math.min(100, Math.max(-100, drag.settings.mixer[key][i] + delta * weight)); });
            }
            state.settings = normalize(s);
            this.changed();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Building the panel (UI/FilterSheet.swift:165-197, UI/CameraRawControls.swift:14-120)

        build() {
            const board = this.board;
            const el = h('div', { class: 'floating-panel docked craw-panel', role: 'dialog', 'aria-label': 'Camera Raw Filter', tabindex: '-1' });
            el.innerHTML = `<div class="panel-title">Camera Raw Filter<button class="panel-close" title="Close" aria-label="Close">${svg('close')}</button></div>`;
            this.histogram = this.buildHistogram();
            el.append(this.histogram.el);
            this.readoutEl = h('div', { class: 'craw-readout', title: 'Red, green, and blue of the pixel under the pointer.' });
            el.append(this.readoutEl);
            const scroll = h('div', { class: 'craw-scroll' });
            this.sectionsEl = h('div', { class: 'craw-sections' });
            scroll.append(this.sectionsEl);
            el.append(scroll);
            this.scrollEl = scroll;
            this.previewEl = h('label', { class: 'check craw-preview' }, h('input', { type: 'checkbox', checked: true }), ' Preview');
            this.previewEl.querySelector('input').addEventListener('change', (e) => this.setPreview(e.target.checked));
            this.errorEl = h('div', { class: 'panel-error craw-error' });
            this.limitedEl = h('div', { class: 'craw-limited' }, 'Limited to the selection');
            const footer = h('div', { class: 'buttons' },
                h('button', { class: 'pill cancel', onclick: () => this.cancel() }, 'Cancel'),
                h('span', { class: 'spacer' }),
                h('span', { class: 'craw-applying' }, h('span', { class: 'spinner' }), 'Applying…'),
                h('button', { class: 'pill ok prominent', onclick: () => this.ok() }, 'OK'));
            el.append(this.previewEl, this.errorEl, this.limitedEl, h('hr'), footer);
            el.querySelector('.panel-close').addEventListener('click', () => this.cancel());
            el.addEventListener('pointerdown', (e) => e.stopPropagation());
            el.addEventListener('keydown', (e) => this.keydown(e));
            this.sections = {};
            for (const section of SECTIONS) {
                const header = h('div', { class: 'craw-header' });
                const body = h('div', { class: 'craw-body' });
                this.sectionsEl.append(h('div', { class: 'craw-section' }, header, body));
                this.sections[section.id] = { header, body, key: null, updaters: [] };
                this.buildHeader(section);
            }
            document.getElementById('app').append(el);
            this.el = el;
            // The board's Escape and Return reach the panel as its Cancel and OK while the canvas has the focus.
            if (board.openPanel && board.openPanel !== el) board.cancelPanel();
            board.openPanel = el;
            board.panelCancel = () => this.cancel();
        }

        keydown(e) {
            e.stopPropagation();
            const field = e.target.tagName === 'INPUT' && e.target.type !== 'checkbox';
            if (field) return;
            if (CB.Shortcuts.isCancel(e)) { e.preventDefault(); this.cancel(); }
            else if (CB.Shortcuts.isApply(e) && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'SELECT') { e.preventDefault(); this.ok(); }
        }

        setPreview(on) {
            const state = this.state;
            state.preview = on;
            // Preview off: the layer shows its own pixels (updateFilter drops preparedPreview); on again, the last preview
            // shows until the next render replaces it.
            if (!on) this.resetWork();
            this.showWork();
            this.changed();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Histogram and readout (camera-raw.md 3)

        buildHistogram() {
            const canvas = h('canvas', { class: 'craw-graph', 'aria-label': 'RGB histogram' });
            const clip = (shadows) => h('button', {
                class: `craw-clip ${shadows ? 'left' : 'right'}`, title: shadows ? 'Show clipped shadows in blue on the preview.' : 'Show clipped highlights in red on the preview.',
                'aria-label': shadows ? 'Shadow Clipping Indicator' : 'Highlight Clipping Indicator', html: svg('triangle'),
                onclick: () => {
                    const overlay = this.state.overlay;
                    if (shadows) overlay.shadowClipping = !overlay.shadowClipping;
                    else overlay.highlightClipping = !overlay.highlightClipping;
                    this.changed();
                },
            });
            const el = h('div', { class: 'craw-histogram' }, canvas, clip(true), clip(false));
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.board.menu(e.clientX, e.clientY, [
                    { label: 'Histogram', run: () => { this.state.scopeMode = 'histogram'; this.refresh(); } },
                    { label: 'Vectorscope', run: () => { this.state.scopeMode = 'vectorscope'; this.refresh(); } },
                ]);
            });
            return { el, canvas };
        }

        drawHistogram() {
            const state = this.state, { el, canvas } = this.histogram;
            const mode = state.scopeMode;
            el.title = mode === 'histogram'
                ? 'Tones from black on the left to white on the right: blacks, shadows, midtones, highlights, whites. Control-click to show the vectorscope.'
                : 'Hue around the wheel, saturation outward from the center. Control-click to show the histogram.';
            canvas.setAttribute('aria-label', mode === 'histogram' ? 'RGB histogram' : 'Vectorscope');
            el.querySelector('.craw-clip.left').style.color = state.overlay.shadowClipping ? css(SYSTEM.blue) : 'rgba(255,255,255,0.55)';
            el.querySelector('.craw-clip.right').style.color = state.overlay.highlightClipping ? css(SYSTEM.red) : 'rgba(255,255,255,0.55)';
            const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth || 392, ht = 110;
            if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(ht * dpr); }
            const ctx = canvas.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, ht);
            const scope = state.scope;
            if (!scope) return;
            if (mode === 'histogram') {
                const peak = scope.peak;
                if (!(peak > 0)) return;
                for (const [bins, color] of [[scope.red, SYSTEM.red], [scope.green, SYSTEM.green], [scope.blue, SYSTEM.blue]]) {
                    ctx.beginPath();
                    ctx.moveTo(0, ht);
                    bins.forEach((v, i) => ctx.lineTo((i * w) / bins.length, ht - ht * Math.min(1, Math.max(0, v / peak))));
                    ctx.lineTo(w, ht);
                    ctx.closePath();
                    ctx.fillStyle = css(color, 0.55);
                    ctx.fill();
                }
            } else {
                // Square cells of width/64 from the bottom up (CameraRawControls.swift:95-106), as the app draws them.
                const peak = scope.vectorPeak;
                if (!(peak > 0)) return;
                const cell = w / 64;
                scope.vectorscope.forEach((v, i) => {
                    if (!(v > 0)) return;
                    ctx.fillStyle = `rgba(255,255,255,${0.15 + 0.85 * Math.min(1, v / peak)})`;
                    ctx.fillRect((i % 64) * cell, ht - (Math.floor(i / 64) + 1) * cell, cell + 0.2, cell + 0.2);
                });
            }
        }

        refreshReadout() {
            const r = this.state && this.state.readout;
            if (this.readoutEl) this.readoutEl.textContent = r ? `R ${r[0]}   G ${r[1]}   B ${r[2]}` : 'R —   G —   B —';
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Section headers (camera-raw.md 4)

        buildHeader(section) {
            const entry = this.sections[section.id];
            const toggle = h('button', { class: 'craw-disclosure', 'aria-label': section.title, onclick: () => {
                const expanded = this.state.expanded;
                if (expanded.has(section.id)) expanded.delete(section.id); else expanded.add(section.id);
                this.refresh();
            } });
            const eye = h('button', { class: 'craw-icon craw-eye', onclick: () => {
                this.state.eyes[section.id] = !this.state.eyes[section.id];
                this.changed();
            } });
            const reset = h('button', { class: 'craw-icon craw-reset', html: svg('reset'), title: `Reset ${section.title} to its defaults`, 'aria-label': `Reset ${section.title}`,
                onclick: () => this.resetGroup(section.id) });
            entry.header.append(toggle, h('span', { class: 'spacer' }), eye, reset);
            entry.toggle = toggle;
            entry.eye = eye;
            entry.reset = reset;
        }

        // resetCameraRaw (CameraRawReset.swift:112-123): the section back to its defaults, shown again.
        resetGroup(group) {
            const state = this.state;
            if (state.committing) return;
            state.settings = normalize(resetting(state.settings, group));
            state.eyes[group] = true;
            if (group === 'colorMixer') state.pointIndex = 0;
            if (group === 'geometry') this.guideDraft = null;
            this.changed();
        }

        refreshHeader(section) {
            const state = this.state, entry = this.sections[section.id];
            const expanded = state.expanded.has(section.id);
            entry.toggle.innerHTML = `<span class="craw-chevron">${svg(expanded ? 'chevronDown' : 'chevronRight')}</span><span class="craw-title">${escape(section.title)}</span>`;
            const adjusts = ADJUSTS[section.id](state.settings), shown = state.eyes[section.id];
            entry.eye.style.display = adjusts ? '' : 'none';
            entry.reset.style.display = adjusts ? '' : 'none';
            entry.eye.innerHTML = svg(shown ? 'eye' : 'eyeSlash');
            entry.eye.title = shown ? `Hide ${section.title} in the preview` : `Show ${section.title} in the preview`;
            entry.eye.setAttribute('aria-label', shown ? `Hide ${section.title}` : `Show ${section.title}`);
            entry.reset.disabled = state.committing;
        }

        // What decides a section body's shape; values are updated in place.
        structureKey(id) {
            const s = this.state, a = s.armed, set = s.settings;
            switch (id) {
                case 'color': return String(a.whiteBalance);
                case 'colorGrading': return s.gradePage;
                case 'curve': return [s.curvePage, s.pointChannel, a.curveTarget].join();
                case 'colorMixer': return [s.mixerPage, s.mixerTab, set.mixer.points.length, s.pointIndex < set.mixer.points.length, a.pointColor, a.mixerTarget].join();
                case 'optics': return [set.optics.enableLensProfile, a.defringe].join();
                case 'geometry': return [set.geometry.upright, a.guides, set.geometry.guides.length > 0].join();
                default: return '';
            }
        }

        refresh() {
            const state = this.state;
            if (!state || !this.el) return;
            for (const section of SECTIONS) {
                this.refreshHeader(section);
                const entry = this.sections[section.id];
                if (!state.expanded.has(section.id)) {
                    if (entry.key !== null) { entry.body.replaceChildren(); entry.key = null; entry.updaters = []; }
                    continue;
                }
                const key = this.structureKey(section.id);
                // A body rebuilt under the pointer would end the drag: it waits for the drag to end.
                if (entry.key !== key && (!this.dragging || entry.key === null)) {
                    entry.updaters = [];
                    this.building = entry;
                    entry.body.replaceChildren(...this.buildBody(section.id));
                    this.building = null;
                    entry.key = key;
                }
                for (const update of entry.updaters) update();
            }
            this.previewEl.querySelector('input').checked = state.preview;
            this.errorEl.textContent = state.error || '';
            this.errorEl.style.display = state.error ? '' : 'none';
            this.limitedEl.style.display = state.limited ? '' : 'none';
            this.el.classList.toggle('committing', state.committing);
            this.el.querySelector('.craw-applying').style.display = state.committing ? '' : 'none';
            // The whole sheet is disabled while OK applies (FilterSheet.swift:197).
            for (const n of this.el.querySelectorAll('button, input, select')) n.disabled = state.committing || n.dataset.disabled === 'true';
            this.drawHistogram();
            this.refreshReadout();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Rows (camera-raw.md 5.2)

        updater(fn) {
            if (this.building) this.building.updaters.push(fn);
        }

        get s() {
            return this.state.settings;
        }

        // Changes the settings through `fn` (on a copy), normalizes, and renders.
        edit(fn) {
            if (this.state.committing) return;
            const s = clone(this.state.settings);
            fn(s);
            this.state.settings = normalize(s);
            this.changed();
        }

        // A row: label (optional scrub and double-click reset), slider, optional field. o: { title, help, labelWidth,
        // fixedLabel, min, max, get(), set(value, how, event) with how 'slide' | 'scrub' | 'field' | 'reset', reset,
        // scrub: sensitivity or 0, labelReset, field: { width, decimals, left } or null, track(), disabled() }.
        row(o) {
            const label = h('span', {
                class: `craw-label${o.scrub ? ' scrub' : ''}`, title: o.help,
                style: o.fixedLabel ? `width:${o.labelWidth}px;flex:none` : `min-width:${o.labelWidth}px`,
            }, o.title);
            if (o.scrub) {
                // NumericScrub: a horizontal drag of at least 1 point; start + dx · sensitivity, clamped, not rounded.
                label.addEventListener('pointerdown', (e) => {
                    if (e.button !== 0 || (o.disabled && o.disabled())) return;
                    label.setPointerCapture(e.pointerId);
                    const start = o.get(), x0 = e.clientX;
                    let moved = false;
                    this.dragging++;
                    label.onpointermove = (m) => {
                        if (!moved && Math.abs(m.clientX - x0) < 1) return;
                        moved = true;
                        o.set(Math.min(o.max, Math.max(o.min, start + (m.clientX - x0) * o.scrub)), 'scrub', m);
                    };
                    label.onpointerup = label.onpointercancel = () => {
                        label.onpointermove = label.onpointerup = label.onpointercancel = null;
                        this.dragging = Math.max(0, this.dragging - 1);
                        this.refresh();
                    };
                });
            }
            if (o.labelReset) label.addEventListener('dblclick', () => o.set(o.reset, 'reset'));
            const slider = new CRSlider(this, {
                min: o.min, max: o.max, get: o.get, help: o.help, width: o.sliderWidth, track: o.track, disabled: o.disabled,
                slide: (value, e) => o.set(value, 'slide', e), reset: () => o.set(o.reset, 'reset'),
            });
            const parts = [label, slider.el];
            let field = null;
            if (o.field) {
                field = h('input', { class: `num craw-field${o.field.left ? ' left' : ''}`, title: o.help, 'aria-label': o.title, style: `width:${o.field.width}px` });
                const commit = () => {
                    const v = Number(String(field.value).replace(',', '.'));
                    if (field.value.trim() !== '' && Number.isFinite(v)) o.set(v, 'field');
                    // Stored normalized at once, so an out-of-range value shows clamped (typing 150 in Contrast shows 100).
                    field.value = formatted(o.get(), o.field.decimals);
                };
                field.addEventListener('change', commit);
                field.addEventListener('keydown', (e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') { e.preventDefault(); commit(); field.select(); }
                    else if (e.key === 'Escape') { e.preventDefault(); field.value = formatted(o.get(), o.field.decimals); field.blur(); this.el.focus(); }
                });
                parts.push(field);
            }
            const el = h('div', { class: 'craw-row' }, ...parts);
            this.updater(() => {
                slider.update();
                const disabled = Boolean(o.disabled && o.disabled());
                el.classList.toggle('dim', disabled);
                if (field) {
                    if (document.activeElement !== field) field.value = formatted(o.get(), o.field.decimals);
                    field.dataset.disabled = String(disabled);
                }
            });
            return el;
        }

        // Light, Color and Effects rows (slider(...), CameraRawControls.swift:338-379): rounded to `decimals` on the
        // slider; Exposure, Highlights and Whites show clipped highlights with ⌥, Shadows and Blacks clipped shadows.
        toneRow(title, key, { min = -100, max = 100, decimals = 0, clipping = null, track = null, reset = 0, help }) {
            const step = 10 ** decimals;
            return this.row({
                title, help, labelWidth: LABEL, min, max, reset, scrub: 1 / step, labelReset: true,
                field: { width: 56, decimals }, track: track ? () => track : null,
                get: () => this.s[key],
                set: (value, how, e) => {
                    const v = how === 'slide' ? roundHalfAway(value * step) / step : value;
                    this.state.overlay.clipping = how === 'slide' && clipping && e && e.altKey ? clipping : null;
                    this.edit((s) => {
                        s[key] = v;
                        if (key === 'temperature' || key === 'tint') s.whiteBalance = 'Custom';
                    });
                },
            });
        }

        // Rows of Detail, Optics, Geometry and Calibration: label minWidth 96 with scrub 1/pt, 56 pt right-aligned field.
        settingRow(title, path, { min, max, reset, help, round = true, decimals = 0, onSet = null, disabled = null }) {
            return this.row({
                title, help, labelWidth: LABEL, min, max, reset, scrub: 1 / 10 ** decimals, field: { width: 56, decimals }, disabled,
                get: () => getPath(this.s, path),
                set: (value, how, e) => {
                    if (onSet) onSet(how, e);
                    this.edit((s) => setPath(s, path, how === 'slide' && round ? roundHalfAway(value) : value));
                },
            });
        }

        // Curve amounts and HSL family rows: fixed labels, unrounded, a 48 pt field (fractionLength 0).
        narrowRow(title, path, { labelWidth, help, track = null, field = true, scrub = true, min = -100, max = 100, reset = 0 }) {
            return this.row({
                title, help, labelWidth, fixedLabel: true, min, max, reset, scrub: scrub ? 1 : 0,
                field: field ? { width: 48, decimals: 0, left: true } : null, track,
                get: () => getPath(this.s, path),
                set: (value) => this.edit((s) => setPath(s, path, value)),
            });
        }

        subheading(text) {
            return h('div', { class: 'craw-subheading' }, text);
        }

        caption(text) {
            return h('div', { class: 'craw-caption' }, text);
        }

        segmented(options, get, set, help) {
            const el = h('div', { class: 'segmented craw-segmented', title: help });
            for (const [value, label] of options) {
                const b = h('button', { onclick: () => set(value) }, label);
                el.append(b);
                this.updater(() => b.classList.toggle('on', get() === value));
            }
            return el;
        }

        // A pop-up, with its title on the left unless `title` is null (labels hidden).
        popup(title, options, get, set, help) {
            const select = h('select', { class: 'pop', title: help, 'aria-label': title || help },
                ...options.map((o) => h('option', { value: o }, o)));
            select.addEventListener('change', () => set(select.value));
            this.updater(() => { if (document.activeElement !== select) select.value = get(); });
            return title ? h('label', { class: 'craw-popup', title: help }, h('span', {}, title), select) : select;
        }

        checkbox(title, get, set, help) {
            const input = h('input', { type: 'checkbox' });
            input.addEventListener('change', () => set(input.checked));
            this.updater(() => { input.checked = get(); });
            return h('label', { class: 'check', title: help }, input, ` ${title}`);
        }

        // A borderless eyedropper (or labelled tool) button, in the accent color while armed.
        armButton(key, { icon, label, help, aria, bordered = false, onToggle }) {
            const b = h('button', { class: `craw-arm${bordered ? ' bordered' : ''}`, title: help, 'aria-label': aria || label || help,
                html: `${svg(icon)}${label ? `<span>${escape(label)}</span>` : ''}` });
            b.addEventListener('click', () => {
                if (onToggle) onToggle();
                else this.state.armed[key] = !this.state.armed[key];
                this.refresh();
                this.board.view.cursor();
            });
            this.updater(() => b.classList.toggle('armed', Boolean(this.state.armed[key])));
            return b;
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Section bodies

        buildBody(id) {
            switch (id) {
                case 'light': return this.lightBody();
                case 'color': return this.colorBody();
                case 'colorGrading': return this.gradingBody();
                case 'effects': return this.effectsBody();
                case 'curve': return this.curveBody();
                case 'colorMixer': return this.mixerBody();
                case 'detail': return this.detailBody();
                case 'optics': return this.opticsBody();
                case 'geometry': return this.geometryBody();
                case 'calibration': return this.calibrationBody();
                default: return [];
            }
        }

        // Light (CameraRawControls.swift:199-214).
        lightBody() {
            return [
                this.toneRow('Exposure', 'exposure', { min: -5, max: 5, decimals: 2, clipping: 'highlights', help: 'Brightens or darkens the whole picture, in stops of light. Hold Option to see clipped highlights.' }),
                this.toneRow('Contrast', 'contrast', { help: 'Makes light and dark tones more or less different, mostly around the middle.' }),
                this.toneRow('Highlights', 'highlights', { clipping: 'highlights', help: 'Adjusts the bright parts of the picture. Hold Option to see clipped highlights.' }),
                this.toneRow('Shadows', 'shadows', { clipping: 'shadows', help: 'Adjusts the dark parts of the picture. Hold Option to see clipped shadows.' }),
                this.toneRow('Whites', 'whites', { clipping: 'highlights', help: 'Sets the brightest point. Hold Option to see clipped highlights.' }),
                this.toneRow('Blacks', 'blacks', { clipping: 'shadows', help: 'Sets the darkest point. Hold Option to see clipped shadows.' }),
            ];
        }

        // Color (CameraRawControls.swift:216-250).
        colorBody() {
            const help = 'Auto balances the average color. Custom follows Temperature and Tint.';
            const picker = this.popup(null, ['Custom', 'Auto'], () => this.s.whiteBalance, (mode) => {
                if (mode === 'Auto') {
                    // applyCameraRawAutoWhiteBalance: the mode moves on the click; the balance follows from the engine.
                    this.edit((s) => { s.whiteBalance = 'Auto'; });
                    this.pump.actions.push({ kind: 'autoWhiteBalance' });
                    this.run();
                } else this.edit((s) => { s.whiteBalance = mode; });
            }, help);
            const rows = [h('div', { class: 'craw-row' },
                h('span', { class: 'craw-label', style: `min-width:${LABEL}px`, title: help }, 'White Balance'), picker,
                this.armButton('whiteBalance', { icon: 'eyedropper', help: 'Click a pixel that should be neutral.', aria: 'White Balance Selector' }))];
            if (this.state.armed.whiteBalance) rows.push(this.caption('Click the original layer. Click the eyedropper again to stop.'));
            rows.push(
                this.toneRow('Temperature', 'temperature', { track: TRACKS.temperature(), help: 'Shifts the picture from blue to yellow.' }),
                this.toneRow('Tint', 'tint', { track: TRACKS.tint(), help: 'Shifts the picture from green to mauve.' }),
                this.toneRow('Vibrance', 'vibrance', { track: TRACKS.chroma(), help: 'Strengthens quiet colors more than colors that are already strong, and protects skin tones.' }),
                this.toneRow('Saturation', 'saturation', { track: TRACKS.chroma(), help: 'Strengthens or weakens every color by the same amount.' }));
            return rows;
        }

        // Effects (CameraRawControls.swift:252-302).
        effectsBody() {
            const nested = (...rows) => h('div', { class: 'craw-nested' }, ...rows);
            return [
                this.toneRow('Texture', 'texture', { help: 'Adds or softens small detail.' }),
                this.toneRow('Clarity', 'clarity', { help: 'Adds or softens contrast along broader shapes.' }),
                this.toneRow('Dehaze', 'dehaze', { help: 'Clears haze when raised, and adds haze when lowered.' }),
                this.subheading('Glow'),
                this.toneRow('Glow', 'glow', { min: 0, max: 100, help: 'Spreads a glow from the bright areas.' }),
                this.popup('Style', ['Diffusion', 'Bloom', 'Halation'], () => this.s.glowStyle, (v) => this.edit((s) => { s.glowStyle = v; }),
                    'Diffusion is soft and wide, Bloom is tighter, and Halation is a red fringe.'),
                nested(
                    this.toneRow('Range', 'glowRange', { help: 'Chooses how bright an area must be to glow. Has no effect until Glow is raised.' }),
                    this.toneRow('Spread', 'glowSpread', { help: 'Sets how far the glow reaches. Has no effect until Glow is raised.' }),
                    this.toneRow('Warmth', 'glowWarmth', { help: 'Shifts the glow from cool to warm. Halation stays red. Has no effect until Glow is raised.' })),
                this.subheading('Vignette'),
                this.toneRow('Amount', 'vignetteAmount', { help: 'Darkens or lightens the edges. The center does not change.' }),
                this.popup('Style', ['Highlight Priority', 'Color Priority', 'Paint Overlay'], () => this.s.vignetteStyle, (v) => this.edit((s) => { s.vignetteStyle = v; }),
                    'Highlight Priority protects bright edges. Color Priority also reduces color. Paint Overlay covers the edges evenly.'),
                nested(
                    this.toneRow('Midpoint', 'vignetteMidpoint', { min: 0, max: 100, reset: 50, help: 'Sets where the vignette begins, from the center outward.' }),
                    this.toneRow('Roundness', 'vignetteRoundness', { help: 'Makes the vignette rounder or more square.' }),
                    this.toneRow('Feather', 'vignetteFeather', { min: 0, max: 100, reset: 50, help: 'Softens the edge of the vignette.' }),
                    this.toneRow('Highlights', 'vignetteHighlights', { min: 0, max: 100, help: 'Protects bright pixels while a dark vignette is applied. Used by Highlight Priority.' })),
                this.subheading('Grain'),
                this.toneRow('Amount', 'grainAmount', { min: 0, max: 100, help: 'Adds film grain, strongest in the middle tones.' }),
                this.toneRow('Size', 'grainSize', { min: 0, max: 100, reset: 25, help: 'Makes the grain coarser or finer.' }),
                this.toneRow('Roughness', 'grainRoughness', { min: 0, max: 100, reset: 50, help: 'Makes the grain smoother or more uneven.' }),
            ];
        }

        // Color Grading (CameraRawColorControls.swift:426-500).
        gradingBody() {
            const state = this.state;
            const page = this.popup(null, ['Three-Way', 'Shadows', 'Midtones', 'Highlights', 'Global'], () => state.gradePage,
                (value) => { state.gradePage = value; this.refresh(); }, 'Three-Way shows shadows, midtones, and highlights. The other choices show one wheel.');
            page.classList.add('craw-fixed');
            const key = { 'Three-Way': 'shadows', Shadows: 'shadows', Midtones: 'midtones', Highlights: 'highlights', Global: 'global' }[state.gradePage];
            const wheels = state.gradePage === 'Three-Way'
                ? h('div', { class: 'craw-wheels' }, this.wheel('Shadows', 'shadows'), this.wheel('Midtones', 'midtones'), this.wheel('Highlights', 'highlights'))
                : h('div', { class: 'craw-wheels single' }, this.wheel(state.gradePage, key));
            const slider = (title, path, min, max, reset, help) => this.row({
                title, help, labelWidth: 78, fixedLabel: true, min, max, reset, scrub: 0, field: null,
                get: () => getPath(this.s, path), set: (value) => this.edit((s) => setPath(s, path, value)),
            });
            return [page, wheels,
                slider('Blending', 'grading.blending', 0, 100, 50, 'Controls how much the three tonal wheels overlap.'),
                slider('Balance', 'grading.balance', -100, 100, 0, 'Shifts the wheels toward shadows or highlights.')];
        }

        // GradeWheel (CameraRawColorControls.swift:502-537): hue counterclockwise from red at the right, saturation
        // outward; the luminance slider under it.
        wheel(title, key) {
            const side = 86, radius = side / 2 - 6;
            const canvas = h('canvas', { class: 'craw-wheel', title: 'Drag to set hue and saturation. Double-click to reset this wheel.' });
            const dpr = window.devicePixelRatio || 1;
            canvas.width = side * dpr;
            canvas.height = side * dpr;
            const readout = h('div', { class: 'craw-wheel-readout', title: 'Hue and saturation of this wheel.' });
            const draw = () => {
                const w = this.s.grading[key], ctx = canvas.getContext('2d');
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.clearRect(0, 0, side, side);
                const gradient = ctx.createConicGradient(0, side / 2, side / 2);
                for (let angle = 0; angle <= 360; angle += 30) gradient.addColorStop(angle / 360, css(hsv((360 - angle) % 360, 1, 1)));
                ctx.globalAlpha = 0.85;
                ctx.fillStyle = gradient;
                ctx.beginPath();
                ctx.arc(side / 2, side / 2, side / 2, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = 1;
                ctx.strokeStyle = 'rgba(255,255,255,0.8)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.arc(side / 2, side / 2, side / 2 - 0.5, 0, Math.PI * 2);
                ctx.stroke();
                const a = (w.hue * Math.PI) / 180, d = (w.saturation / 100) * radius;
                ctx.fillStyle = '#fff';
                ctx.beginPath();
                ctx.arc(side / 2 + Math.cos(a) * d, side / 2 - Math.sin(a) * d, 5, 0, Math.PI * 2);
                ctx.fill();
                readout.textContent = `${roundHalfAway(w.hue)}°  ${roundHalfAway(w.saturation)}`;
            };
            const set = (e) => {
                const r = canvas.getBoundingClientRect();
                const dx = e.clientX - r.left - side / 2, dy = side / 2 - (e.clientY - r.top);
                let degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
                if (degrees < 0) degrees += 360;
                const saturation = Math.min(100, (Math.hypot(dx, dy) / radius) * 100);
                this.edit((s) => { s.grading[key].hue = degrees; s.grading[key].saturation = saturation; });
            };
            canvas.addEventListener('pointerdown', (e) => {
                const r = canvas.getBoundingClientRect();
                if (e.button !== 0 || Math.hypot(e.clientX - r.left - side / 2, e.clientY - r.top - side / 2) > side / 2) return;
                canvas.setPointerCapture(e.pointerId);
                this.dragging++;
                set(e);
                canvas.onpointermove = set;
                canvas.onpointerup = canvas.onpointercancel = () => {
                    canvas.onpointermove = canvas.onpointerup = canvas.onpointercancel = null;
                    this.dragging = Math.max(0, this.dragging - 1);
                    this.refresh();
                };
            });
            canvas.addEventListener('dblclick', () => this.edit((s) => { s.grading[key].hue = 0; s.grading[key].saturation = 0; }));
            this.updater(draw);
            const luminance = new CRSlider(this, {
                min: -100, max: 100, width: 96, help: 'Brightness added by this wheel.', get: () => this.s.grading[key].luminance,
                slide: (value) => this.edit((s) => { s.grading[key].luminance = value; }), reset: () => this.edit((s) => { s.grading[key].luminance = 0; }),
            });
            this.updater(() => luminance.update());
            return h('div', { class: 'craw-wheel-box' },
                h('div', { class: 'craw-wheel-title', title: 'Drag inside the wheel. Angle sets hue, distance sets saturation.' }, title),
                canvas, readout, luminance.el);
        }

        // Curve (CameraRawColorControls.swift:3-260).
        curveBody() {
            const state = this.state;
            const rows = [this.segmented([['Parametric', 'Parametric'], ['Point', 'Point']], () => state.curvePage,
                (v) => { state.curvePage = v; this.refresh(); }, 'Parametric lifts tonal regions. Point places anchors on the curve.')];
            if (state.curvePage === 'Point') {
                rows.push(this.segmented([['rgb', 'RGB'], ['red', 'Red'], ['green', 'Green'], ['blue', 'Blue']], () => state.pointChannel,
                    (v) => { state.pointChannel = v; state.curveSelected = null; this.curveDrag = null; this.refresh(); },
                    'RGB changes brightness. Red, green, and blue also shift the color.'));
            }
            rows.push(this.curveGraph());
            if (state.curvePage === 'Parametric') {
                for (const [title, key, help] of [['Highlights', 'highlights', 'Lifts or lowers the brightest tones.'], ['Lights', 'lights', 'Lifts or lowers the light tones.'],
                    ['Darks', 'darks', 'Lifts or lowers the dark tones.'], ['Shadows', 'shadows', 'Lifts or lowers the darkest tones.']]) {
                    rows.push(this.narrowRow(title, `curve.${key}`, { labelWidth: 88, help }));
                }
            } else {
                const inout = h('div', { class: 'craw-caption mono', title: 'Input and output of the selected curve point.' });
                this.updater(() => {
                    const p = this.selectedPoint();
                    inout.style.display = p ? '' : 'none';
                    if (p) inout.textContent = `In ${roundHalfAway(p.x * 255)}   Out ${roundHalfAway(p.y * 255)}`;
                });
                rows.push(inout);
                rows.push(this.popup('Preset', ['Custom', 'Linear', 'Medium Contrast', 'Strong Contrast'], () => {
                    const points = this.s.curve[state.pointChannel];
                    return samePoints(points, linear()) ? 'Linear' : samePoints(points, MEDIUM) ? 'Medium Contrast' : samePoints(points, STRONG) ? 'Strong Contrast' : 'Custom';
                }, (value) => {
                    const points = { Linear: linear(), 'Medium Contrast': MEDIUM, 'Strong Contrast': STRONG }[value];
                    if (points) this.edit((s) => { s.curve[state.pointChannel] = clone(points); });
                    else this.refresh();
                }, 'Replaces this curve with a straight line or a contrast curve.'));
                if (state.pointChannel === 'rgb') {
                    rows.push(this.narrowRow('Refine Saturation', 'curve.refineSaturation', { labelWidth: 88,
                        help: 'How much the curve also changes color strength. Zero matches Photoshop; lower keeps it to brightness, higher adds more color.' }));
                }
            }
            rows.push(this.armButton('curveTarget', { icon: 'scope', label: 'Targeted Adjustment', bordered: true,
                help: 'Drag on the picture to move the curve for the tone under the pointer.',
                onToggle: () => { state.armed.mixerTarget = false; state.armed.curveTarget = !state.armed.curveTarget; } }));
            return rows;
        }

        selectedPoint() {
            const state = this.state, points = this.s.curve[state.pointChannel];
            return state.curveSelected !== null && state.curveSelected < points.length ? points[state.curveSelected] : null;
        }

        curveGraph() {
            const state = this.state, height = 150;
            const canvas = h('canvas', { class: 'craw-curve' });
            const box = h('div', { class: 'craw-curve-box' }, canvas);
            this.updater(() => {
                box.title = state.curvePage === 'Parametric'
                    ? 'Drag up or down to lift or lower those tones. Drag a divider along the bottom to change which tones each region covers.'
                    : 'Drag a point. Click to add one. Double-click a point to remove it.';
                const dpr = window.devicePixelRatio || 1, w = box.clientWidth || 374;
                if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(height * dpr); }
                const ctx = canvas.getContext('2d');
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.clearRect(0, 0, w, height);
                ctx.strokeStyle = 'rgba(255,255,255,0.25)';
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(0, height); ctx.lineTo(w, 0); ctx.stroke();
                const stroke = (samples) => {
                    ctx.strokeStyle = '#fff';
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    samples.forEach((v, i) => { const x = (i / Math.max(1, samples.length - 1)) * w, y = (1 - v) * height; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
                    ctx.stroke();
                };
                const c = this.s.curve;
                if (state.curvePage === 'Parametric') {
                    stroke(Array.from({ length: 64 }, (_, i) => parametric(c, i / 63)));
                    ctx.strokeStyle = '#fff';
                    ctx.lineWidth = 3;
                    for (const split of [c.shadowSplit, c.darkSplit, c.lightSplit]) {
                        const x = (split / 100) * w;
                        ctx.beginPath(); ctx.moveTo(x, height - 8); ctx.lineTo(x, height); ctx.stroke();
                    }
                } else {
                    const points = c[state.pointChannel];
                    stroke(channelTable(points));
                    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0a84ff';
                    points.forEach((p, i) => {
                        ctx.fillStyle = state.curveSelected === i ? accent : '#fff';
                        ctx.beginPath(); ctx.arc(p.x * w, (1 - p.y) * height, 4, 0, Math.PI * 2); ctx.fill();
                    });
                }
            });
            // One drag does everything: what it moves is picked at the press and kept until release.
            canvas.addEventListener('pointerdown', (e) => {
                if (e.button !== 0 || state.committing) return;
                const r = canvas.getBoundingClientRect(), w = r.width;
                const start = { x: e.clientX - r.left, y: e.clientY - r.top };
                // Counted first, so the section is not rebuilt under the press by the point it adds.
                this.dragging++;
                const drag = state.curvePage === 'Parametric' ? this.parametricDrag(start, w, height) : this.pointDrag(start, w, height);
                if (!drag) { this.dragging = Math.max(0, this.dragging - 1); return; }
                canvas.setPointerCapture(e.pointerId);
                this.curveDrag = drag;
                const move = (m) => this.continueCurveDrag(drag, { x: m.clientX - r.left, y: m.clientY - r.top }, start, w, height);
                move(e);
                canvas.onpointermove = move;
                canvas.onpointerup = canvas.onpointercancel = () => {
                    canvas.onpointermove = canvas.onpointerup = canvas.onpointercancel = null;
                    this.curveDrag = null;
                    this.dragging = Math.max(0, this.dragging - 1);
                    this.refresh();
                };
            });
            canvas.addEventListener('dblclick', (e) => {
                if (state.curvePage !== 'Point') return;
                // Removes the inner point nearest in x within 0.04 of the click.
                const r = canvas.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
                const points = clone(this.s.curve[state.pointChannel]);
                let index = -1;
                for (let i = 1; i < points.length - 1; i++) if (index < 0 || Math.abs(points[i].x - x) < Math.abs(points[index].x - x)) index = i;
                if (index < 0 || Math.abs(points[index].x - x) >= 0.04) return;
                points.splice(index, 1);
                state.curveSelected = null;
                this.edit((s) => { s.curve[state.pointChannel] = points; });
            });
            return box;
        }

        // parametricDrag: along the bottom 18 points the nearest divider, elsewhere the region under the pointer.
        parametricDrag(start, w, height) {
            const c = this.s.curve, tone = (start.x / Math.max(w, 1)) * 100;
            const splits = [c.shadowSplit, c.darkSplit, c.lightSplit];
            if (start.y > height - 18) {
                let index = 0;
                splits.forEach((split, i) => { if (Math.abs(split - tone) < Math.abs(splits[index] - tone)) index = i; });
                return { kind: 'divider', index };
            }
            const key = tone < splits[0] ? 'shadows' : tone < splits[1] ? 'darks' : tone < splits[2] ? 'lights' : 'highlights';
            return { kind: 'region', key, start: c[key] };
        }

        // pointDrag: a point within 0.055 is taken; else one is added there (fewer than 16, inside 0.01…0.99, not within
        // 0.01 of another in x).
        pointDrag(start, w, height) {
            const state = this.state, x = start.x / Math.max(w, 1), y = 1 - start.y / Math.max(height, 1);
            const points = clone(this.s.curve[state.pointChannel]);
            let near = -1;
            points.forEach((p, i) => { if (near < 0 || Math.hypot(p.x - x, p.y - y) < Math.hypot(points[near].x - x, points[near].y - y)) near = i; });
            if (near >= 0 && Math.hypot(points[near].x - x, points[near].y - y) < 0.055) { state.curveSelected = near; this.refresh(); return { kind: 'point', index: near }; }
            if (!(points.length < 16 && x > 0.01 && x < 0.99 && points.every((p) => Math.abs(p.x - x) > 0.01))) return null;
            const point = { x, y: Math.min(1, Math.max(0, y)) };
            points.push(point);
            points.sort((a, b) => a.x - b.x);
            const index = points.indexOf(point);
            state.curveSelected = index;
            this.edit((s) => { s.curve[state.pointChannel] = points; });
            return { kind: 'point', index };
        }

        continueCurveDrag(drag, at, start, w, height) {
            const state = this.state;
            const x = at.x / Math.max(w, 1), y = 1 - at.y / Math.max(height, 1);
            if (drag.kind === 'point') {
                const points = clone(this.s.curve[state.pointChannel]);
                const i = drag.index;
                if (i >= points.length) return;
                points[i].y = Math.min(1, Math.max(0, y));
                // The ends stay at the ends; the rest keep their order.
                if (i > 0 && i < points.length - 1) points[i].x = Math.min(points[i + 1].x - 0.01, Math.max(points[i - 1].x + 0.01, x));
                this.edit((s) => { s.curve[state.pointChannel] = points; });
            } else if (drag.kind === 'divider') {
                const value = Math.min(98, Math.max(2, x * 100));
                this.edit((s) => {
                    const c = s.curve;
                    if (drag.index === 0) c.shadowSplit = Math.min(value, c.darkSplit - 2);
                    else if (drag.index === 1) c.darkSplit = Math.min(c.lightSplit - 2, Math.max(c.shadowSplit + 2, value));
                    else c.lightSplit = Math.max(value, c.darkSplit + 2);
                });
            } else {
                const amount = Math.min(100, Math.max(-100, drag.start - ((at.y - start.y) / Math.max(height, 1)) * 200));
                this.edit((s) => { s.curve[drag.key] = roundHalfAway(amount); });
            }
        }

        // Color Mixer (CameraRawColorControls.swift:262-424).
        mixerBody() {
            const state = this.state;
            const rows = [this.segmented([['HSL', 'HSL'], ['Color', 'Color'], ['Point Color', 'Point Color']], () => state.mixerPage,
                (v) => { state.mixerPage = v; this.refresh(); }, 'HSL lists every color. Color edits one family. Point Color adjusts a color you pick.')];
            const trackOf = (index, tab) => (tab === 'saturation' ? TRACKS.saturation(CENTERS[index]) : tab === 'luminance' ? TRACKS.luminance(CENTERS[index]) : TRACKS.hue(CENTERS[index]));
            if (state.mixerPage === 'HSL') {
                rows.push(this.segmented([['hue', 'Hue'], ['saturation', 'Saturation'], ['luminance', 'Luminance']], () => state.mixerTab,
                    (v) => { state.mixerTab = v; this.refresh(); }, 'Hue shifts the color, Saturation its strength, and Luminance its brightness.'));
                const component = { hue: 'Hue', saturation: 'Saturation', luminance: 'Luminance' }[state.mixerTab];
                NAMES.forEach((name, i) => rows.push(this.narrowRow(name, `mixer.${state.mixerTab}.${i}`, {
                    labelWidth: 78, help: `${component} of ${name}.`, track: () => trackOf(i, state.mixerTab),
                })));
            } else if (state.mixerPage === 'Color') {
                const swatches = h('div', { class: 'craw-swatches' });
                NAMES.forEach((name, i) => {
                    const b = h('button', { class: 'craw-swatch', title: `Edit ${name}.`, style: `background:${css(hsv(CENTERS[i], 0.8, 0.9))}`,
                        onclick: () => { state.mixerSwatch = i; this.refresh(); } });
                    this.updater(() => b.classList.toggle('on', state.mixerSwatch === i));
                    swatches.append(b);
                });
                rows.push(swatches);
                for (const [title, tab, help] of [['Hue', 'hue', 'Shifts the selected color family around the wheel.'],
                    ['Saturation', 'saturation', 'Makes the selected color family stronger or quieter.'], ['Luminance', 'luminance', 'Makes the selected color family lighter or darker.']]) {
                    rows.push(this.row({
                        title, help, labelWidth: 88, fixedLabel: true, min: -100, max: 100, reset: 0, scrub: 0, field: null,
                        track: () => trackOf(Math.min(7, state.mixerSwatch), tab),
                        get: () => this.s.mixer[tab][Math.min(7, state.mixerSwatch)],
                        set: (value) => this.edit((s) => { s.mixer[tab][Math.min(7, state.mixerSwatch)] = value; }),
                    }));
                }
            } else rows.push(...this.pointColorRows());
            rows.push(this.armButton('mixerTarget', { icon: 'scope', label: 'Targeted Adjustment', bordered: true,
                help: 'Drag a color in the picture. Nearby color families move together.',
                onToggle: () => { state.armed.curveTarget = false; state.armed.mixerTarget = !state.armed.mixerTarget; } }));
            return rows;
        }

        pointColorRows() {
            const state = this.state, points = this.s.mixer.points;
            const bar = h('div', { class: 'craw-row' }, this.armButton('pointColor', { icon: 'eyedropper', bordered: true, help: 'Click the picture to save a color. Up to eight colors.' }));
            points.forEach((p, i) => {
                const rgb = hsv(p.hue, p.saturation, p.luminance);
                const b = h('button', { class: 'craw-swatch small', title: 'Select this picked color.', style: `background:${css(rgb)}`,
                    onclick: () => { state.pointIndex = i; this.changed(); } });
                this.updater(() => b.classList.toggle('on', state.pointIndex === i));
                bar.append(b);
            });
            const rows = [bar];
            if (state.pointIndex < points.length) {
                const index = () => Math.min(state.pointIndex, this.s.mixer.points.length - 1);
                const pointRow = (title, key, help, { min = -100, max = 100, reset = 0, track = null } = {}) => this.row({
                    title, help, labelWidth: 110, fixedLabel: true, min, max, reset, scrub: 0, field: null, track,
                    get: () => this.s.mixer.points[index()][key],
                    set: (value) => this.edit((s) => { if (s.mixer.points[index()]) s.mixer.points[index()][key] = value; }),
                });
                const hue = () => this.s.mixer.points[index()].hue;
                rows.push(
                    pointRow('Hue Shift', 'hueShift', 'Shifts the picked color around the color wheel.', { track: () => TRACKS.hue(hue()) }),
                    pointRow('Saturation Shift', 'saturationShift', 'Makes the picked color stronger or quieter.', { track: () => TRACKS.saturation(hue()) }),
                    pointRow('Luminance Shift', 'luminanceShift', 'Makes the picked color lighter or darker.', { track: () => TRACKS.luminance(hue()) }),
                    pointRow('Hue Range', 'hueRange', 'How far in hue the adjustment reaches.', { min: 5, max: 180, reset: 30 }),
                    pointRow('Saturation Range', 'saturationRange', 'How far in saturation the adjustment reaches.', { min: 0.05, max: 1, reset: 0.4 }),
                    pointRow('Luminance Range', 'luminanceRange', 'How far in brightness the adjustment reaches.', { min: 0.05, max: 1, reset: 0.4 }),
                    this.checkbox('Visualize Range', () => Boolean((this.s.mixer.points[index()] || {}).visualize),
                        (on) => this.edit((s) => { if (s.mixer.points[index()]) s.mixer.points[index()].visualize = on; }),
                        "Dims the picture outside this color's range. It is not kept when you press OK."));
            }
            return rows;
        }

        // Detail (CameraRawDetailOpticsControls.swift:4-84): whole numbers on the slider; ⌥ on Masking shows the mask.
        detailBody() {
            const row = (title, key, min, max, reset, help, masking, disabled) => this.settingRow(title, `detail.${key}`, {
                min, max, reset, help, disabled,
                onSet: (how, e) => { this.state.overlay.sharpenMask = Boolean(masking && how === 'slide' && e && e.altKey); },
            });
            const noLuminance = () => this.s.detail.noiseLuminance <= 0, noColor = () => this.s.detail.noiseColor <= 0;
            return [
                this.subheading('Sharpening'),
                row('Amount', 'sharpenAmount', 0, 150, 0, 'Controls how strong the sharpening is.'),
                row('Radius', 'sharpenRadius', 0, 100, 10, 'How far from each edge the sharpening reaches, in pixels.'),
                row('Detail', 'sharpenDetail', 0, 100, 25, 'Emphasizes fine texture over broader edges.'),
                row('Masking', 'sharpenMasking', 0, 100, 0, 'Limits sharpening to stronger edges. Hold Option to see the mask.', true),
                this.subheading('Noise Reduction'),
                row('Luminance', 'noiseLuminance', 0, 100, 0, 'Smooths grain and noise in brightness.'),
                row('Luminance Detail', 'noiseLuminanceDetail', 0, 100, 50, 'Preserves fine texture while luminance noise is reduced.', false, noLuminance),
                row('Luminance Contrast', 'noiseLuminanceContrast', 0, 100, 0, 'Keeps local contrast after luminance smoothing.', false, noLuminance),
                row('Color', 'noiseColor', 0, 100, 0, 'Smooths colored speckles.'),
                row('Color Detail', 'noiseColorDetail', 0, 100, 50, 'Preserves colored edges while color noise is reduced.', false, noColor),
                row('Color Smoothness', 'noiseColorSmoothness', 0, 100, 50, 'Makes the color smoothing softer or tighter.', false, noColor),
            ];
        }

        // Optics (CameraRawDetailOpticsControls.swift:86-189): ranges from 0 round to whole numbers, −100…100 do not.
        opticsBody() {
            const state = this.state;
            const row = (title, key, min, max, reset, help) => this.settingRow(title, `optics.${key}`, { min, max, reset, help, round: min >= 0 });
            const flag = (title, key, help) => this.checkbox(title, () => this.s.optics[key], (on) => this.edit((s) => { s.optics[key] = on; }), help);
            const rows = [
                flag('Remove Chromatic Aberration', 'removeChromaticAberration', 'Pulls red and blue fringes apart toward the center to reduce color edging.'),
                flag('Enable Lens Profile Corrections', 'enableLensProfile', 'Applies generic profile strength when camera metadata is not available.'),
            ];
            if (this.s.optics.enableLensProfile) {
                rows.push(this.caption('No lens metadata on this layer. Profile sliders set generic correction strength.'),
                    row('Distortion', 'profileDistortion', 0, 100, 100, 'How much of the profile distortion correction is applied.'),
                    row('Vignetting', 'profileVignetting', 0, 100, 100, 'How much of the profile vignetting correction is applied.'));
            }
            const defringeHelp = 'Click a purple or green fringe to set its hue range.';
            rows.push(this.subheading('Manual'),
                row('Distortion', 'distortion', -100, 100, 0, 'Straightens barrel or pincushion bending.'),
                h('div', { class: 'craw-row' }, h('span', { class: 'craw-label', style: `min-width:${LABEL}px`, title: defringeHelp }, 'Defringe'),
                    this.armButton('defringe', { icon: 'eyedropper', help: defringeHelp })));
            if (state.armed.defringe) rows.push(this.caption('Click the fringe on the layer. Click the eyedropper again to stop.'));
            rows.push(row('Purple Amount', 'purpleAmount', 0, 100, 0, 'Weakens purple fringes inside the purple hue range.'),
                this.hueRange('Purple Hue', 'purpleHueLow', 'purpleHueHigh', 270, 310, 'Hue range where purple defringe runs.'),
                row('Green Amount', 'greenAmount', 0, 100, 0, 'Weakens green fringes inside the green hue range.'),
                this.hueRange('Green Hue', 'greenHueLow', 'greenHueHigh', 60, 120, 'Hue range where green defringe runs.'),
                row('Vignetting', 'vignetteAmount', -100, 100, 0, 'Brightens or darkens the corners to counter lens falloff.'),
                row('Midpoint', 'vignetteMidpoint', 0, 100, 50, 'Moves the vignette correction inward or outward.'));
            return rows;
        }

        hueRange(title, low, high, lowReset, highReset, help) {
            const slider = (key, reset, sliderHelp) => {
                const s = new CRSlider(this, {
                    min: 0, max: 360, help: sliderHelp, get: () => this.s.optics[key],
                    slide: (value) => this.edit((set) => { set.optics[key] = roundHalfAway(value); }),
                    reset: () => this.edit((set) => { set.optics[key] = reset; }),
                });
                this.updater(() => s.update());
                return s.el;
            };
            return h('div', { class: 'craw-hue-range', style: `padding-left:${LABEL + 10}px` },
                h('div', { class: 'craw-caption', title: help }, title),
                h('div', { class: 'craw-row' },
                    h('span', { class: 'craw-tiny', title: 'Start of the hue range, in degrees.' }, 'Low'), slider(low, lowReset, 'Start of the hue range, in degrees.'),
                    h('span', { class: 'craw-tiny', title: 'End of the hue range, in degrees.' }, 'High'), slider(high, highReset, 'End of the hue range, in degrees.')));
        }

        // Geometry (CameraRawGeometryCalibrationControls.swift:4-88).
        geometryBody() {
            const state = this.state, geo = this.s.geometry;
            const rows = [this.subheading('Upright'),
                this.segmented([['Off', 'Off'], ['Guided', 'Guided']], () => this.s.geometry.upright, (mode) => {
                    if (mode !== 'Guided') state.armed.guides = false;
                    this.edit((s) => { s.geometry.upright = mode; });
                }, 'Off leaves the picture as it is. Guided straightens from lines you draw on the picture.')];
            if (geo.upright === 'Guided') {
                rows.push(this.armButton('guides', { icon: 'diagonal', label: 'Draw Guides', bordered: true,
                    help: 'Draw two or more lines on the preview that should be level or vertical.' }));
                if (state.armed.guides) rows.push(this.caption('Drag on the layer to place a guide. Draw at least two lines.'));
                if (geo.guides.length) {
                    rows.push(h('button', { class: 'pill craw-plain', title: 'Remove every guide line.', onclick: () => this.edit((s) => { s.geometry.guides = []; }) }, 'Clear Guides'));
                }
            }
            rows.push(this.popup('Projection', ['Perspective', 'Rectilinear'], () => this.s.geometry.projection, (v) => this.edit((s) => { s.geometry.projection = v; }),
                'Perspective allows stronger keystone. Rectilinear keeps the warp gentler.'));
            const row = (title, key, help, min = -100, max = 100) => this.settingRow(title, `geometry.${key}`, { min, max, reset: 0, help });
            rows.push(row('Vertical', 'vertical', 'Straightens vertical lines toward the center.'),
                row('Horizontal', 'horizontal', 'Straightens horizontal lines toward the center.'),
                row('Rotate', 'rotate', 'Rotates the picture around its center.', -45, 45),
                row('Aspect', 'aspect', 'Stretches width relative to height.'),
                row('Scale', 'scale', 'Zooms the transformed picture within the frame.'),
                row('Offset X', 'offsetX', 'Moves the picture left or right.'),
                row('Offset Y', 'offsetY', 'Moves the picture up or down.'),
                this.checkbox('Constrain Crop', () => this.s.geometry.constrainCrop, (on) => this.edit((s) => { s.geometry.constrainCrop = on; }),
                    'Crops empty edges after the transform and fits the result back into the frame.'));
            return rows;
        }

        // Calibration (CameraRawGeometryCalibrationControls.swift:90-147).
        calibrationBody() {
            const summary = h('div', { class: 'craw-caption' });
            this.updater(() => { summary.textContent = PROCESS[this.s.calibration.process]; summary.title = summary.textContent; });
            const row = (title, key, help) => this.settingRow(title, `calibration.${key}`, { min: -100, max: 100, reset: 0, help });
            return [
                this.popup('Process', Object.keys(PROCESS), () => this.s.calibration.process, (v) => this.edit((s) => { s.calibration.process = v; }),
                    'Chooses how strongly the calibration sliders below are applied. Version 6 is the current default.'),
                summary,
                this.subheading('Shadows'), row('Tint', 'shadowTint', 'Adds green or magenta to the darkest tones.'),
                this.subheading('Red Primary'), row('Hue', 'redHue', 'Shifts how red is interpreted.'), row('Saturation', 'redSaturation', 'Strengthens or weakens the red primary.'),
                this.subheading('Green Primary'), row('Hue', 'greenHue', 'Shifts how green is interpreted.'), row('Saturation', 'greenSaturation', 'Strengthens or weakens the green primary.'),
                this.subheading('Blue Primary'), row('Hue', 'blueHue', 'Shifts how blue is interpreted.'), row('Saturation', 'blueSaturation', 'Strengthens or weakens the blue primary.'),
            ];
        }
    }

    // Dotted paths into the settings ('curve.darks', 'mixer.hue.3', 'grading.shadows.luminance').
    function getPath(s, path) {
        return path.split('.').reduce((value, key) => (value === undefined ? undefined : value[key]), s);
    }

    function setPath(s, path, value) {
        const keys = path.split('.'), last = keys.pop();
        const target = keys.reduce((o, key) => o[key], s);
        target[last] = value;
    }

    // An action's patch laid over the local settings: objects key by key, arrays and values replaced.
    function merge(base, patch) {
        const out = clone(base);
        const lay = (into, from) => {
            for (const [key, value] of Object.entries(from)) {
                if (value && typeof value === 'object' && !Array.isArray(value) && into[key] && typeof into[key] === 'object' && !Array.isArray(into[key])) lay(into[key], value);
                else into[key] = clone(value);
            }
        };
        lay(out, patch);
        return out;
    }

    CB.CameraRaw = {
        defaults, normalize, repair, ADJUSTS, isIdentity, resetting, curveValue, pointValue, channelTable, parametric, region, nudged,
        weights, hsv, merge, CameraRawPanel,
    };

    // The board makes one panel for itself once it exists (board.js runs before DOMContentLoaded).
    window.addEventListener('DOMContentLoaded', () => {
        if (window.board && !window.board.cameraRaw) window.board.cameraRaw = new CameraRawPanel(window.board);
    });
})();
