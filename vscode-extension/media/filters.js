'use strict';
// Compositor's adjustment and filter panels on the board: the Filter panel (upstream UI/FilterSheet.swift,
// CurvesControls.swift; Document/Filters.swift beginFilter, updateFilter, commitFilter, cancelFilter, repeatLastFilter),
// Levels (UI/LevelsSheet.swift, Document/Levels.swift, LevelsAutomatic.swift), Hue/Saturation (UI/HueSaturationSheet.swift,
// Document/HueSaturation.swift), and adjustment layers edited through the same panels (Document/AdjustmentEditing.swift,
// LayerAdjustment.swift). Filter-menu and Image-menu filters preview and apply in compositor-engine, which keeps the
// app's own filter edit open while the panel is (filters.md sections 18-19); Levels and Hue/Saturation preview with the
// board's ports of their kernels and apply in the engine; an adjustment layer's editor writes the layer's settings live
// and becomes one undo step on OK (adjustments-effects.md section 7).

(function () {
    const CB = (window.CB = window.CB || {});
    const { Transform } = CB;
    const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const clamp = (v, lo, hi, fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
    const swiftRound = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));

    // ---------------------------------------------------------------------------------------------------------------
    // FilterSettings (Document/Filters.swift:62-163) in the engine's JSON shape (filters.md section 17)

    const black = () => ({ red: 0, green: 0, blue: 0 });
    const white = () => ({ red: 1, green: 1, blue: 1 });
    function defaultSettings() {
        return {
            radius: 5, preserveTransparency: false, angle: 0, distance: 10, progressiveFrom: 0, progressiveTo: 20,
            progressiveStart: null, progressiveEnd: null, progressiveRadial: false, progressiveInverted: false,
            amount: 10, gaussian: false, monochromatic: false,
            vignetteAmount: 35, vignetteColor: black(), vignetteMidpoint: 50, vignetteRoundness: 100, vignetteFeather: 60, vignetteHighlights: 25,
            bloomAmount: 40, bloomRadius: 24, tonalAmount: 50, tonalRadius: 16, tonalShadows: 40, tonalMidtones: 60, tonalHighlights: 30,
            distortion: 0, backgroundQuality: 'basic', refineEdges: 12, matteContrast: 25, shiftEdge: 0,
            dither: {
                style: 'atkinson', pixelSize: 2, pixelShape: 'square', cellSize: 8, textSize: 14, angle: 45, levels: 2, diffusion: 100,
                density: 0, contrast: 0, colors: 'blackWhite', dark: black(), light: white(), lightOnDark: true, characters: ' .:-=+*#%@',
            },
            scanlines: {
                lineSpacing: 4, thickness: 70, glow: 0, dots: 0, wobble: 0, displace: 0, smoothness: 50, threshold: 0, split: 0,
                density: 0, contrast: 0, blackLevel: 0, colors: 'blackWhite', dark: black(), light: white(),
            },
            curves: CB.Adjust.defaultCurves(), exposure: CB.Adjust.DEFAULTS.exposure(), gradientMap: CB.Adjust.DEFAULTS.gradientMap(),
            grain: CB.Adjust.DEFAULTS.grain(), blackWhite: CB.Adjust.DEFAULTS.blackWhite(), colorBalance: CB.Adjust.DEFAULTS.colorBalance(),
        };
    }

    // FilterSettings.normalized for the kinds an adjustment layer edits (Filters.swift:127-162): the board applies it
    // itself there, as no engine edit is open. Curves, Black & White and Color Balance are not normalized.
    function normalizedLayerSettings(s) {
        const n = clone(s);
        n.radius = clamp(s.radius, 0.1, 250, 5);
        n.angle = clamp(s.angle, -90, 90, 0);
        n.distance = clamp(s.distance, 1, 2000, 10);
        n.amount = clamp(s.amount, 0.1, 400, 10);
        n.exposure = { exposure: clamp(s.exposure.exposure, -20, 20, 0), offset: clamp(s.exposure.offset, -0.5, 0.5, 0), gamma: clamp(s.exposure.gamma, 0.01, 9.99, 1) };
        const c = (x) => ({ red: clamp(x.red, 0, 1, 0), green: clamp(x.green, 0, 1, 0), blue: clamp(x.blue, 0, 1, 0) });
        n.gradientMap = { ...s.gradientMap, shadows: c(s.gradientMap.shadows), highlights: c(s.gradientMap.highlights) };
        n.grain = { ...s.grain, amount: clamp(s.grain.amount, 0, 100, 25), size: clamp(s.grain.size, 0.5, 20, 1.5), roughness: clamp(s.grain.roughness, 0, 100, 50) };
        return n;
    }

    const get = (s, path) => path.split('.').reduce((o, k) => (o === null || o === undefined ? o : o[k]), s);
    function set(s, path, value) {
        const keys = path.split('.'), out = clone(s);
        let o = out;
        for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
        o[keys[keys.length - 1]] = value;
        return out;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Slider tracks (UI/CameraRawSlider.swift:21-55, FilterSheet.swift:339-344)

    function hsb(degrees, s, b) {
        let turns = degrees / 360;
        turns -= Math.floor(turns);
        const rgb = CB.Color.hsvToRgb(turns * 360, s, b);
        return `rgb(${rgb.map((v) => Math.round(v * 255)).join(',')})`;
    }
    const rgb = (r, g, b) => `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
    const TRACKS = {
        plain: () => null,
        chroma: () => [rgb(0.62, 0.62, 0.64), rgb(0.86, 0.18, 0.20)],
        saturation: (h) => [rgb(0.55, 0.55, 0.56), hsb(h, 0.9, 0.9)],
        luminance: (h) => [hsb(h, 0.55, 0.18), hsb(h, 0.35, 0.95)],
        spectrum: (h) => { const out = []; for (let k = -180; k <= 180; k += 30) out.push(hsb(h + k, 0.85, 0.9)); return out; },
        opposing: (a, b) => [a, b],
    };
    const CYAN_RED = () => TRACKS.opposing(rgb(0.10, 0.72, 0.80), rgb(0.86, 0.18, 0.20));
    const MAGENTA_GREEN = () => TRACKS.opposing(rgb(0.80, 0.22, 0.70), rgb(0.24, 0.70, 0.30));
    const YELLOW_BLUE = () => TRACKS.opposing(rgb(0.95, 0.82, 0.18), rgb(0.22, 0.40, 0.92));

    // ---------------------------------------------------------------------------------------------------------------
    // The Filter panel's control lists (filters.md 19.1; UI/FilterSheet.swift:21-163, 206-313)

    const HALFTONE = ['dots', 'lines', 'diamonds'];
    const COLORS_MENU = [[['blackWhite', 'Black & White'], ['twoColors', 'Two Colors'], ['original', 'Original']]];
    const balance = (prefix, label) => [
        { type: 'heading', text: label },
        { type: 'slider', key: `colorBalance.${prefix}CyanRed`, label: 'Cyan / Red', min: -100, max: 100, unit: '', decimals: 0, track: CYAN_RED },
        { type: 'slider', key: `colorBalance.${prefix}MagentaGreen`, label: 'Magenta / Green', min: -100, max: 100, unit: '', decimals: 0, track: MAGENTA_GREEN },
        { type: 'slider', key: `colorBalance.${prefix}YellowBlue`, label: 'Yellow / Blue', min: -100, max: 100, unit: '', decimals: 0, track: YELLOW_BLUE },
    ];
    const FILTERS = {
        'Gaussian Blur': [
            { type: 'slider', key: 'radius', label: 'Radius', min: 0.1, max: 250, unit: 'px', decimals: 1, log: true },
            { type: 'toggle', key: 'preserveTransparency', label: 'Preserve Transparency', help: "Blur only the colors, keeping the layer's outline and transparency as they are" },
        ],
        'Motion Blur': [
            { type: 'slider', key: 'angle', label: 'Angle', min: -90, max: 90, unit: '°', decimals: 0 },
            { type: 'slider', key: 'distance', label: 'Distance', min: 1, max: 2000, unit: 'px', decimals: 0, log: true },
        ],
        'Progressive Blur': [
            { type: 'text', text: 'Click and drag two points on canvas', tone: 'secondary' },
            { type: 'segmented', key: 'progressiveRadial', label: 'Shape', options: [[false, 'Linear'], [true, 'Radial']], fill: false, help: 'Linear blurs along the line; Radial keeps the start sharp and blurs outwards' },
            { type: 'slider', key: 'progressiveFrom', label: 'From', min: 0, max: 250, unit: 'px', decimals: 1, help: 'The blur where the line starts' },
            { type: 'slider', key: 'progressiveTo', label: 'To', min: 0, max: 250, unit: 'px', decimals: 1, help: 'The blur where the line ends, and past it' },
            { type: 'toggle', key: 'progressiveInverted', label: 'Invert', help: 'Swap From and To: blur the start and sharpen toward the end' },
        ],
        'Add Noise': [
            { type: 'slider', key: 'amount', label: 'Amount', min: 0.1, max: 400, unit: '%', decimals: 1, log: true },
            { type: 'segmented', key: 'gaussian', label: 'Distribution', options: [[false, 'Uniform'], [true, 'Gaussian']], fill: true },
            { type: 'toggle', key: 'monochromatic', label: 'Monochromatic' },
        ],
        Vignette: [
            { type: 'swatch', key: 'vignetteColor', label: 'Color', labelWidth: 95, pickerTitle: 'Color Picker (Vignette Color)', help: 'Choose the vignette color' },
            { type: 'slider', key: 'vignetteAmount', label: 'Amount', min: 0, max: 100, unit: '%', decimals: 0, help: 'Blend the chosen color into the edges while keeping the center unchanged' },
            { type: 'slider', key: 'vignetteMidpoint', label: 'Midpoint', min: 0, max: 100, unit: '%', decimals: 0 },
            { type: 'slider', key: 'vignetteRoundness', label: 'Roundness', min: -100, max: 100, unit: '', decimals: 0 },
            { type: 'slider', key: 'vignetteFeather', label: 'Feather', min: 0, max: 100, unit: '%', decimals: 0 },
            { type: 'slider', key: 'vignetteHighlights', label: 'Highlights', min: 0, max: 100, unit: '%', decimals: 0, help: 'Protect bright areas near the edge' },
        ],
        'Bloom / Glow': [
            { type: 'slider', key: 'bloomAmount', label: 'Amount', min: 0, max: 100, unit: '%', decimals: 0 },
            { type: 'slider', key: 'bloomRadius', label: 'Radius', min: 1, max: 150, unit: 'px', decimals: 0, log: true },
        ],
        Dither: [
            { type: 'menu', key: 'dither.style', label: 'Style', fixed: false, groups: [
                [['atkinson', 'Atkinson (Classic Mac)'], ['floydSteinberg', 'Floyd–Steinberg']],
                [['bayer2', 'Bayer 2 × 2'], ['bayer4', 'Bayer 4 × 4'], ['bayer8', 'Bayer 8 × 8']],
                [['dots', 'Halftone Dots'], ['lines', 'Halftone Lines'], ['diamonds', 'Halftone Diamonds']],
                [['patterns', 'Mac Patterns'], ['ascii', 'ASCII']]] },
            { type: 'slider', key: 'dither.pixelSize', label: 'Pixel Size', min: 1, max: 32, unit: 'px', decimals: 0, visible: (s) => s.dither.style !== 'ascii', help: 'Make each dithered pixel this many pixels across, for a chunky old-screen look' },
            { type: 'slider', key: 'dither.textSize', label: 'Text Size', min: 6, max: 64, unit: 'px', decimals: 0, visible: (s) => s.dither.style === 'ascii', help: 'The height of each line of characters' },
            { type: 'slider', key: 'dither.cellSize', label: 'Cell Size', min: 4, max: 64, unit: 'px', decimals: 0, visible: (s) => HALFTONE.includes(s.dither.style) },
            { type: 'slider', key: 'dither.angle', label: 'Angle', min: -90, max: 90, unit: '°', decimals: 0, visible: (s) => HALFTONE.includes(s.dither.style) },
            { type: 'textField', key: 'dither.characters', label: 'Characters', monospaced: true, visible: (s) => s.dither.style === 'ascii', help: 'The characters to draw with, in any order: each spot gets the one whose ink best matches its tone' },
            { type: 'slider', key: 'dither.levels', label: 'Tones', min: 2, max: 8, unit: '', decimals: 0, visible: (s) => ['atkinson', 'floydSteinberg', 'bayer2', 'bayer4', 'bayer8'].includes(s.dither.style), help: 'Tones per channel: 2 is pure black and white' },
            { type: 'slider', key: 'dither.diffusion', label: 'Diffusion', min: 0, max: 100, unit: '%', decimals: 0, visible: (s) => ['atkinson', 'floydSteinberg'].includes(s.dither.style), help: "How much of each pixel's error spreads to its neighbors. Less gives flatter areas" },
            { type: 'slider', key: 'dither.density', label: 'Density', min: -100, max: 100, unit: '', decimals: 0, help: 'More ink (darker) or less before dithering' },
            { type: 'slider', key: 'dither.contrast', label: 'Contrast', min: -100, max: 100, unit: '', decimals: 0 },
            { type: 'menu', key: 'dither.colors', label: 'Colors', fixed: true, groups: COLORS_MENU },
            { type: 'swatches', visible: (s) => s.dither.colors === 'twoColors', items: [
                { key: 'dither.dark', label: 'Dark', pickerTitle: 'Color Picker (Dark Color)', help: 'Choose the dark color' },
                { key: 'dither.light', label: 'Light', pickerTitle: 'Color Picker (Light Color)', help: 'Choose the light color' }] },
            { type: 'menu', key: 'dither.pixelShape', label: 'Pixel Shape', fixed: true, groups: [[['square', 'Square'], ['dot', 'Dot']]], visible: (s) => s.dither.pixelSize > 1 && s.dither.style !== 'ascii', help: 'Draw each chunky pixel as a solid square, or as a round dot like a dot-matrix screen' },
            { type: 'toggle', key: 'dither.lightOnDark', label: 'Light on Dark', visible: (s) => [...HALFTONE, 'patterns', 'ascii'].includes(s.dither.style), help: 'Draw the marks for the light tones on the dark color, like a glowing screen' },
        ],
        Scanlines: [
            { type: 'slider', key: 'scanlines.lineSpacing', label: 'Line Spacing', min: 2, max: 32, unit: 'px', decimals: 0, help: "How far apart the screen's lines are" },
            { type: 'slider', key: 'scanlines.thickness', label: 'Thickness', min: 5, max: 100, unit: '%', decimals: 0, help: 'How much of the gap a bright line fills; dimmer parts draw it thinner' },
            { type: 'slider', key: 'scanlines.glow', label: 'Glow', min: 0, max: 100, unit: '%', decimals: 0, help: "Light blooming around the lines, like a CRT's phosphors" },
            { type: 'slider', key: 'scanlines.dots', label: 'Dots', min: 0, max: 100, unit: '%', decimals: 0, help: "Break the lines into beads where the picture is darker than this, blending into solid lines where it's brighter" },
            { type: 'slider', key: 'scanlines.displace', label: 'Displace', min: -100, max: 100, unit: 'px', decimals: 0, help: 'Lift the lines where the picture is bright, or lower them when negative, so they swell into its shapes' },
            { type: 'slider', key: 'scanlines.smoothness', label: 'Smoothness', min: 0, max: 100, unit: '%', decimals: 0, help: 'How far the brightness is smoothed before it displaces the lines, from sharp ridges to rounded hills' },
            { type: 'slider', key: 'scanlines.threshold', label: 'Threshold', min: 0, max: 100, unit: '%', decimals: 0, help: 'Draw no line where the picture is darker than this, leaving the screen dark' },
            { type: 'slider', key: 'scanlines.wobble', label: 'Wobble', min: 0, max: 64, unit: 'px', decimals: 0, help: 'Make the lines waver sideways down the screen, like a CRT losing sync' },
            { type: 'slider', key: 'scanlines.split', label: 'Color Split', min: 0, max: 16, unit: 'px', decimals: 0, help: 'Move the red and blue apart, for colored fringes on the lines' },
            { type: 'slider', key: 'scanlines.density', label: 'Density', min: -100, max: 100, unit: '', decimals: 0, help: 'Darker or lighter before the lines are drawn' },
            { type: 'slider', key: 'scanlines.contrast', label: 'Contrast', min: -100, max: 100, unit: '', decimals: 0 },
            { type: 'slider', key: 'scanlines.blackLevel', label: 'Black Level', min: 0, max: 100, unit: '%', decimals: 0, help: 'How bright the lines are where the picture is black, so they show even over black' },
            { type: 'menu', key: 'scanlines.colors', label: 'Colors', fixed: true, groups: COLORS_MENU },
            { type: 'swatches', visible: (s) => s.scanlines.colors === 'twoColors', items: [
                { key: 'scanlines.dark', label: 'Dark', pickerTitle: 'Color Picker (Dark Color)', help: "Choose the screen's color" },
                { key: 'scanlines.light', label: 'Light', pickerTitle: 'Color Picker (Light Color)', help: "Choose the lines' color" }] },
        ],
        'Tonal Contrast': [
            { type: 'slider', key: 'tonalAmount', label: 'Amount', min: 0, max: 100, unit: '%', decimals: 0 },
            { type: 'slider', key: 'tonalShadows', label: 'Shadows', min: -100, max: 100, unit: '%', decimals: 0 },
            { type: 'slider', key: 'tonalMidtones', label: 'Midtones', min: -100, max: 100, unit: '%', decimals: 0 },
            { type: 'slider', key: 'tonalHighlights', label: 'Highlights', min: -100, max: 100, unit: '%', decimals: 0 },
            { type: 'slider', key: 'tonalRadius', label: 'Radius', min: 1, max: 100, unit: 'px', decimals: 0, log: true },
        ],
        'Lens Correction': [
            { type: 'slider', key: 'distortion', label: 'Remove Distortion', min: -100, max: 100, unit: '', decimals: 0 },
            { type: 'text', tone: 'callout', text: 'Positive straightens lines that bow outward (barrel); negative, lines that bow inward (pincushion).' },
        ],
        'Remove Background': [
            { type: 'text', tone: 'body', text: 'Hide the background behind a layer mask, keeping the foreground subjects. The pixels stay, so the background can be painted back at any time.' },
            { type: 'segmented', key: 'backgroundQuality', label: null, options: [['basic', 'Basic'], ['advanced', 'Advanced']], fill: true, help: "Basic is quick; Advanced refines the mask against the layer's own detail, for hair and fur" },
            { type: 'slider', key: 'refineEdges', label: 'Refine', min: 0, max: 40, unit: 'px', decimals: 0, visible: (s) => s.backgroundQuality === 'advanced', help: "Pull the mask onto the image's own edges, which recovers hair and fur" },
            { type: 'slider', key: 'matteContrast', label: 'Contrast', min: 0, max: 100, unit: '%', decimals: 0, visible: (s) => s.backgroundQuality === 'advanced', help: 'Clear the haze that leaves background showing through thin areas' },
            { type: 'slider', key: 'shiftEdge', label: 'Shift Edge', min: -10, max: 10, unit: 'px', decimals: 0, visible: (s) => s.backgroundQuality === 'advanced', help: 'Shrink the mask to drop the rim of background color around the subject, or grow it' },
        ],
        'Content-Aware Fill': [
            { type: 'text', tone: 'body', text: 'Fill the selection using surrounding pixels from this layer.' },
        ],
        // Image menu (filters.md section 5, UI/FilterSheet.swift:22-67).
        Curves: [{ type: 'curves', key: 'curves' }],
        Exposure: [
            { type: 'slider', key: 'exposure.exposure', label: 'Exposure', min: -20, max: 20, unit: '', decimals: 2 },
            { type: 'slider', key: 'exposure.offset', label: 'Offset', min: -0.5, max: 0.5, unit: '', decimals: 4 },
            { type: 'slider', key: 'exposure.gamma', label: 'Gamma', min: 0.01, max: 9.99, unit: '', decimals: 2, log: true },
        ],
        'Gradient Map': [{ type: 'gradientMap', key: 'gradientMap' }],
        'Black & White': [
            { type: 'slider', key: 'blackWhite.reds', label: 'Reds', min: -200, max: 300, unit: '%', decimals: 0, track: () => TRACKS.luminance(0) },
            { type: 'slider', key: 'blackWhite.yellows', label: 'Yellows', min: -200, max: 300, unit: '%', decimals: 0, track: () => TRACKS.luminance(60) },
            { type: 'slider', key: 'blackWhite.greens', label: 'Greens', min: -200, max: 300, unit: '%', decimals: 0, track: () => TRACKS.luminance(120) },
            { type: 'slider', key: 'blackWhite.cyans', label: 'Cyans', min: -200, max: 300, unit: '%', decimals: 0, track: () => TRACKS.luminance(180) },
            { type: 'slider', key: 'blackWhite.blues', label: 'Blues', min: -200, max: 300, unit: '%', decimals: 0, track: () => TRACKS.luminance(240) },
            { type: 'slider', key: 'blackWhite.magentas', label: 'Magentas', min: -200, max: 300, unit: '%', decimals: 0, track: () => TRACKS.luminance(300) },
            { type: 'toggle', key: 'blackWhite.tint', label: 'Tint', help: 'Color the result while keeping its tones, for a sepia or a cyanotype' },
            { type: 'slider', key: 'blackWhite.tintHue', label: 'Hue', min: 0, max: 360, unit: '°', decimals: 0, track: () => TRACKS.plain(), visible: (s) => s.blackWhite.tint },
            { type: 'slider', key: 'blackWhite.tintSaturation', label: 'Saturation', min: 0, max: 100, unit: '%', decimals: 0, track: (s) => TRACKS.saturation(s.blackWhite.tintHue), visible: (s) => s.blackWhite.tint },
        ],
        'Color Balance': [
            ...balance('shadow', 'Shadows'), ...balance('mid', 'Midtones'), ...balance('highlight', 'Highlights'),
            { type: 'toggle', key: 'colorBalance.preserveLuminosity', label: 'Preserve Luminosity', help: "Put each pixel's brightness back afterwards, so only the color moves" },
        ],
        Grain: [
            { type: 'slider', key: 'grain.amount', label: 'Amount', min: 0, max: 100, unit: '', decimals: 0 },
            { type: 'slider', key: 'grain.size', label: 'Size', min: 0.5, max: 20, unit: 'px', decimals: 1, log: true },
            { type: 'slider', key: 'grain.roughness', label: 'Roughness', min: 0, max: 100, unit: '', decimals: 0 },
        ],
    };
    // FilterKind order of the Filter menu and of the Image menu's panel kinds (CompositorApp.swift:294-340).
    const FILTER_MENU = ['Gaussian Blur', 'Motion Blur', 'Progressive Blur', 'Add Noise', 'Vignette', 'Bloom / Glow', 'Dither', 'Scanlines',
        'Tonal Contrast', 'Lens Correction', 'Camera Raw Filter', 'Remove Background'];
    const IMAGE_KINDS = ['Black & White', 'Color Balance', 'Exposure', 'Gradient Map', 'Grain'];
    const AUTOMATIC = new Set(['Content-Aware Fill', 'Remove Background']);

    // Where each panel was last left, for this board (FloatingPanelController names, ContentView.swift:12-16).
    const POSITIONS = {};
    const PANEL_NAME = { filter: 'filterPanel', levels: 'levelsPanel', hueSaturation: 'adjustmentPanel' };

    const fieldText = (v, decimals, fixed) => (Number.isFinite(v)
        ? v.toLocaleString(undefined, { minimumFractionDigits: fixed ? decimals : 0, maximumFractionDigits: decimals }) : '');
    const parseField = (text) => Number(String(text).replace(/,/g, '').trim());
    const css = (c) => rgb(c.red, c.green, c.blue);

    // The eyedropper with an optional plus or minus badge (HueSampleMode), and the targeted-adjustment hand.
    const EYEDROPPER = '<path d="M14.5 4.5a2.8 2.8 0 0 1 4 4l-2 2-4-4z"/><path d="M12.5 6.5l5 5M13.8 10.2l-7.6 7.6-2.7.7.7-2.7 7.6-7.6"/>';
    const glyph = (paths, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}${extra}</svg>`;
    const BADGES = {
        Sample: '',
        Add: '<circle cx="19" cy="19" r="4.2" fill="currentColor" stroke="none"/><path d="M19 16.8v4.4M16.8 19h4.4" stroke="#222" stroke-width="1.4"/>',
        Remove: '<circle cx="19" cy="19" r="4.2" fill="currentColor" stroke="none"/><path d="M16.8 19h4.4" stroke="#222" stroke-width="1.4"/>',
    };
    const HAND = '<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V10M12 10V4a1.5 1.5 0 0 1 3 0v6M15 10V5.5a1.5 1.5 0 0 1 3 0V13a7 7 0 0 1-7 7h-.6a6 6 0 0 1-4.3-1.8l-3.4-3.5a1.5 1.5 0 0 1 2.1-2.1L9 14.5V11"/><path d="M3 4l3 3M3 4h3M3 4v3"/>';
    const HUE_SAMPLE_HELP = {
        Sample: 'Click the image to center this range on that color',
        Add: 'Click the image to widen this range to include that color',
        Remove: 'Click the image to narrow this range to exclude that color',
    };

    // HueBand edits (HueSaturation.swift:56-131) on [falloffStart, rangeStart, rangeEnd, falloffEnd].
    const fwd = (from, to) => { const d = (to - from) % 360; return d < 0 ? d + 360 : d; };
    const wrap = (v) => { const r = v % 360; return r < 0 ? r + 360 : r; };
    function normalizeBand(b) {
        const out = b.map(wrap);
        if (fwd(out[0], out[3]) > 350) out[3] = wrap(out[0] + 350);
        return out;
    }
    function bandCentered(b, hue) {
        const core = fwd(b[1], b[2]), leading = fwd(b[0], b[1]), trailing = fwd(b[2], b[3]);
        const start = wrap(hue - core / 2);
        return [wrap(start - leading), start, wrap(start + core), wrap(start + core + trailing)];
    }
    function bandInclude(b, hue) {
        if (CB.Adjust.bandWeight(b, hue) >= 1) return b;
        const shoulderIn = fwd(b[0], b[1]), shoulderOut = fwd(b[2], b[3]);
        const out = b.slice();
        if (fwd(hue, b[1]) <= fwd(b[2], hue)) { out[1] = hue; out[0] = hue - shoulderIn; } else { out[2] = hue; out[3] = hue + shoulderOut; }
        return normalizeBand(out);
    }
    function bandExclude(b, hue) {
        if (!(CB.Adjust.bandWeight(b, hue) > 0)) return b;
        const shoulderIn = fwd(b[0], b[1]), shoulderOut = fwd(b[2], b[3]);
        const out = b.slice();
        if (fwd(b[0], hue) <= fwd(hue, b[3])) { out[0] = hue + 1; out[1] = hue + 1 + shoulderIn; } else { out[3] = hue - 1; out[2] = hue - 1 - shoulderOut; }
        return normalizeBand(out);
    }
    function bandSetHandle(b, index, degrees) {
        const value = (((degrees % 360) + 360) % 360);
        const out = b.slice();
        out[index] = value;
        const span = fwd(out[0], out[3]), toStart = fwd(out[0], out[1]), toEnd = fwd(out[0], out[2]);
        return span > 1 && span <= 350 && toStart <= toEnd && toEnd <= span ? out : b;
    }

    // LevelsAuto.settings (LevelsAutomatic.swift:6-36) and LevelsSettings.sampling (:38-59).
    function autoLevels(mode, histogram) {
        const result = CB.Adjust.defaultLevels();
        const endpoints = (bins) => {
            const total = bins.reduce((a, b) => a + b, 0);
            if (!(total > 0)) return null;
            let sum = 0, low = 0, high = 255;
            for (let i = 0; i < 256; i++) { sum += bins[i]; if (sum > total * 0.001) { low = i; break; } }
            sum = 0;
            for (let i = 255; i >= 0; i--) { sum += bins[i]; if (sum > total * 0.001) { high = i; break; } }
            return low < high ? [low, high] : null;
        };
        if (mode === 'Contrast') {
            const limits = histogram.slice(1).map(endpoints).filter(Boolean);
            if (limits.length) {
                const low = Math.min(...limits.map((l) => l[0])), high = Math.max(...limits.map((l) => l[1]));
                if (low < high) result.ranges[0] = { ...CB.Adjust.identityRange(), black: low, white: high };
            }
        } else {
            for (let c = 1; c <= 3; c++) {
                const e = endpoints(histogram[c]);
                if (!e) continue;
                const range = { ...CB.Adjust.identityRange(), black: e[0], white: e[1] };
                if (mode === 'Color + neutral midtones') {
                    const total = histogram[c].reduce((a, b) => a + b, 0);
                    const mean = histogram[c].reduce((acc, bin, i) => acc + CB.Adjust.rangeApply(range, i / 255) * bin, 0) / total;
                    if (mean > 0 && mean < 1) range.gamma = Math.min(9.99, Math.max(0.1, Math.log(mean) / Math.log(0.5)));
                }
                result.ranges[c] = range;
            }
        }
        return result;
    }
    function levelsSampling(levels, sample, mode) {
        const result = clone(levels);
        result.ranges[0] = CB.Adjust.identityRange();
        for (let c = 1; c <= 3; c++) {
            const range = { ...result.ranges[c] };
            const v = sample[c - 1] * 255;
            if (mode === 'Black') range.black = Math.min(range.white - 1, Math.max(0, v));
            else if (mode === 'White') range.white = Math.max(range.black + 1, Math.min(255, v));
            else {
                const fraction = (v - range.black) / (range.white - range.black);
                if (!(fraction > 0 && fraction < 1)) continue;
                range.gamma = Math.log(fraction) / Math.log(0.5);
            }
            range.outputBlack = 0;
            range.outputWhite = 255;
            result.ranges[c] = CB.Adjust.normalizedRange(range);
        }
        return result;
    }
    // LevelsHistogramDisplay.scale (Levels.swift:47-56).
    function histogramScale(bins) {
        const positive = bins.filter((b) => Number.isFinite(b) && b > 0);
        const peak = positive.length ? Math.max(...positive) : 0;
        if (!(peak > 0)) return 0;
        const interior = bins.slice(1, -1).filter((b) => Number.isFinite(b) && b > 0).sort((a, b) => a - b);
        if (!interior.length) return peak;
        return Math.min(peak, interior[Math.trunc((interior.length - 1) * 0.95)] * 4);
    }

    // The HSB hue of a sampled color, or null when it is near neutral (sampledHue, HueSaturation.swift:569-579).
    function hueOf(rgb3) {
        const [r, g, b] = rgb3, high = Math.max(r, g, b), low = Math.min(r, g, b), delta = high - low;
        const saturation = high > 0 ? delta / high : 0;
        if (!(saturation > 0.02) || !(delta > 0)) return null;
        let h = high === r ? (g - b) / delta : high === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
        h *= 60;
        return h < 0 ? h + 360 : h;
    }

    // ---------------------------------------------------------------------------------------------------------------

    class FilterPanel {
        constructor(board) {
            this.board = board;
            this.current = null;
            // What the next Filter panel starts from, and what Filter › Last Filter runs (EditorSession.swift:254-258).
            this.filterSettings = null;
            this.lastFilter = null;
            board.editAdjustment = (id) => this.editAdjustment(id);
            // ⌥P toggles the Levels preview while Levels is open, wherever the focus is (KeyboardShortcuts.swift:141).
            window.addEventListener('keydown', (e) => {
                const edit = this.current;
                if (!edit || edit.type !== 'levels' || e.code !== 'KeyP' || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
                if (CB.isTyping && CB.isTyping(e.target) && !(edit.element && edit.element.contains(e.target))) return;
                e.preventDefault();
                e.stopPropagation();
                this.setPreview(!edit.preview);
            }, true);
        }

        // Camera Raw is one of the filters too (FilterKind.cameraRaw): its panel (media/camera-raw.js) holds the same
        // gate while it is open, as filterEdit != nil does upstream.
        get isOpen() {
            return Boolean(this.current) || Boolean(this.board.cameraRaw && this.board.cameraRaw.isOpen);
        }

        get edit() {
            return this.current;
        }

        // The board clears this when it loads another project: whatever was open goes, without an undo step.
        set edit(value) {
            if (value) { this.current = value; return; }
            const edit = this.current;
            if (!edit) return;
            this.current = null;
            if (edit.id) this.board.engine('filter.cancel', { edit: edit.id }, { stateless: true }).catch(() => {});
            this.endEditing(edit, false);
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Enabling (HueSaturation.swift:445-462)

        canAdjust(allowingEmpty) {
            const board = this.board, record = board.activeLayer();
            if (!board.doc.manifest || !record || this.isOpen || board.textDraft || board.working || board.view.busy || board.renamingID) return false;
            if (board.openPanel || board.selectTools.colorRange || board.selectedIDs.size !== 1 || record.isGroup || board.isMaskSelected) return false;
            if (!board.doc.entry(record.id).image && (!allowingEmpty || record.adjustment)) return false;
            return board.effectivelyVisible(record) && !(board.selection && CB.Selection.isEmpty(board.selection)) && !board.isLocked(record);
        }

        canAdjustColors() {
            return this.canAdjust(false);
        }

        canVignette() {
            return this.canAdjust(true);
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Menus (CompositorApp.swift:294-349)

        imageMenuItems() {
            return [
                { label: 'Curves…', def: 'Curves', enabled: () => this.canAdjustColors(), run: () => this.open('Curves') },
                { label: 'Levels…', def: 'Levels', enabled: () => this.canAdjustColors(), run: () => this.openLevels() },
                { label: 'Hue/Saturation…', def: 'Hue/Saturation', enabled: () => this.canAdjustColors(), run: () => this.openHueSaturation() },
                ...IMAGE_KINDS.map((kind) => ({ label: `${kind}…`, enabled: () => this.canAdjustColors(), run: () => this.open(kind) })),
            ];
        }

        filterMenuItems() {
            const board = this.board;
            return [
                { label: () => (this.lastFilter ? `Last Filter: ${this.lastFilter}` : 'Last Filter'), def: 'Last Filter', enabled: () => this.canRepeatLastFilter(), run: () => this.repeatLastFilter() },
                null,
                ...FILTER_MENU.map((kind) => ({
                    label: `${kind}…`,
                    // Camera Raw has a panel of its own (camera-raw.md); the item works once that panel is on the board.
                    enabled: () => (kind === 'Camera Raw Filter' ? Boolean(board.cameraRaw) && this.canAdjustColors()
                        : kind === 'Vignette' ? this.canVignette() : this.canAdjustColors()),
                    run: () => (kind === 'Camera Raw Filter' ? board.cameraRaw.open() : this.open(kind)),
                })),
            ];
        }

        layerMenuItems() {
            const board = this.board;
            const active = () => board.activeLayer();
            return [
                { label: 'New Adjustment Layer', submenu: CB.Adjust.KINDS.map((kind) => ({
                    label: kind + (CB.Adjust.isEditable(kind) ? '…' : ''), enabled: () => board.canEditLayers(), run: () => this.addAdjustment(kind),
                })) },
                // Not for Invert, which has nothing to edit (adjustments-effects.md section 12, quirk 8).
                { label: 'Edit Adjustment…', enabled: () => board.canEditLayers() && Boolean(active() && active().adjustment && CB.Adjust.isEditable(active().adjustment.kind)) && !board.isLocked(active()),
                    run: () => this.editAdjustment(board.activeID()) },
            ];
        }

        // The footer's adjustment menu (UI/LayersPanel.swift:45-49): the kinds without ellipses.
        adjustmentMenu(x, y) {
            this.board.menu(x, y, CB.Adjust.KINDS.map((kind) => ({ label: kind, run: () => this.addAdjustment(kind) })));
        }

        // Layer › New Adjustment Layer (LayerAdjustment.swift:208-229) through the engine, then its editor.
        async addAdjustment(kind) {
            const board = this.board;
            if (!board.canEditLayers()) return;
            if (board.selectTools.floating) await board.selectTools.commitFloating();
            const result = await board.selectionOp('adjustment.add', { kind }, `New ${kind} Adjustment`);
            if (!result || !result.layerID || result.error) return;
            if (result.opensEditor && board.doc.layer(result.layerID)) this.editAdjustment(result.layerID);
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Opening

        // Filter-menu and Image-menu filters: the engine keeps the app's own filter edit open (filters.md 18).
        async open(kind) {
            const board = this.board;
            if (this.current) return;
            if (kind === 'Content-Aware Fill' ? !board.canContentAwareFill() : !(kind === 'Vignette' ? this.canVignette() : this.canAdjustColors())) return;
            // Opening commits a floating transform, cancels drafts and applies a pending gradient (Filters.swift:697-701).
            if (board.selectTools.floating) await board.selectTools.commitFloating();
            board.selectTools.cancelDraft();
            await board.resolvePending('edit');
            const record = board.activeLayer();
            if (!record) return;
            const settings = clone(this.filterSettings || defaultSettings());
            // Gradient Map always starts from the foreground and background colors (Filters.swift:721-724).
            if (kind === 'Gradient Map') {
                const [f, b] = [board.colors.fg, board.colors.bg];
                settings.gradientMap = { shadows: { red: f[0], green: f[1], blue: f[2] }, highlights: { red: b[0], green: b[1], blue: b[2] }, reversed: false };
            }
            const edit = {
                type: 'filter', kind, layerID: record.id, settings, preview: true, committing: false, error: null, shown: null,
                inFlight: false, dirty: false, automatic: AUTOMATIC.has(kind), limited: Boolean(board.selection),
            };
            this.current = edit;
            this.showPanel(edit);
            board.changed();
            await this.begin(edit);
        }

        // Levels (Image menu ⌘L): previews from the layer's own pixels; the histogram from the engine.
        async openLevels() {
            const board = this.board;
            if (this.current || !this.canAdjustColors()) return;
            if (board.selectTools.floating) await board.selectTools.commitFloating();
            board.selectTools.cancelDraft();
            await board.resolvePending('edit');
            const record = board.activeLayer();
            if (!record) return;
            const edit = {
                type: 'levels', kind: 'Levels', layerID: record.id, settings: CB.Adjust.defaultLevels(), preview: true, committing: false,
                histogram: null, sampleMode: null, limited: Boolean(board.selection), source: this.layerSource(record),
            };
            this.current = edit;
            board.levelsEdit = edit;
            this.showPanel(edit);
            board.changed();
            this.loadHistogram(edit, {});
        }

        // Hue/Saturation (Image menu ⌘U).
        async openHueSaturation() {
            const board = this.board;
            if (this.current || !this.canAdjustColors()) return;
            if (board.selectTools.floating) await board.selectTools.commitFloating();
            board.selectTools.cancelDraft();
            await board.resolvePending('edit');
            const record = board.activeLayer();
            if (!record) return;
            const edit = {
                type: 'hueSaturation', kind: 'Hue/Saturation', layerID: record.id, settings: CB.Adjust.hsvSettings(), preview: true,
                committing: false, sampleMode: null, targeting: false, limited: Boolean(board.selection), source: this.layerSource(record),
            };
            this.current = edit;
            this.showPanel(edit);
            board.changed();
        }

        // An adjustment layer's editor (beginAdjustmentEditing, AdjustmentEditing.swift:6-63): the panel of its kind,
        // writing the layer's settings live; the composite under it is cached as its input.
        editAdjustment(id) {
            const board = this.board, record = board.doc.layer(id);
            if (this.current || !record || !record.adjustment || !CB.Adjust.isEditable(record.adjustment.kind) || !board.canEditLayers() || board.refuseLocked([record])) return;
            const original = clone(record.adjustment), kind = original.kind, r = CB.Adjust.resolved(original);
            const common = { layerID: id, adjustmentID: id, original, preview: true, committing: false, limited: false };
            let edit;
            if (kind === 'Levels') {
                edit = { ...common, type: 'levels', kind, settings: clone(r.levels), histogram: null, sampleMode: null };
            } else if (kind === 'Hue/Saturation') {
                edit = { ...common, type: 'hueSaturation', kind, settings: r.hsv, sampleMode: null, targeting: false };
            } else {
                // The settings copied into a fresh FilterSettings (AdjustmentEditing.swift:43-55).
                const settings = defaultSettings();
                Object.assign(settings, {
                    curves: clone(r.curves), exposure: clone(r.exposure), gradientMap: clone(r.gradientMap), grain: clone(r.grain),
                    blackWhite: clone(r.blackWhite), colorBalance: clone(r.colorBalance), radius: r.blurRadius, angle: r.motionAngle,
                    distance: r.motionDistance, amount: r.noiseAmount, gaussian: r.noiseGaussian, monochromatic: r.noiseMonochromatic,
                });
                edit = { ...common, type: 'filter', kind: CB.Adjust.FILTER_KIND[kind], settings: normalizedLayerSettings(settings), error: null };
            }
            this.current = edit;
            board.adjustmentEditingID = id;
            if (edit.type === 'levels') board.levelsEdit = edit;
            board.beginLive(id);
            this.showPanel(edit);
            board.changed();
            if (edit.type === 'levels') this.loadHistogram(edit, { layerID: id });
        }

        // The active layer's pixels for a Levels or Hue/Saturation preview: premultiplied, at most 8000 px on a side
        // (LevelsEdit, HueSaturationEdit previewLimit), with the selection's coverage on that grid.
        layerSource(record) {
            const board = this.board, image = board.doc.entry(record.id).image;
            const transform = Transform.read(record.transform, [board.doc.width, board.doc.height]);
            const factor = Math.min(1, 8000 / Math.max(image.width, image.height));
            const w = Math.max(1, Math.trunc(image.width * factor)), h = Math.max(1, Math.trunc(image.height * factor));
            const surface = CB.Render.canvas2d(w, h);
            surface.ctx.imageSmoothingQuality = 'high';
            surface.ctx.drawImage(image, 0, 0, w, h);
            const pixels = CB.Adjust.toPremultiplied(new Uint8Array(surface.ctx.getImageData(0, 0, w, h).data));
            const toDocument = Transform.pixelToDocument(transform, w, h);
            let coverage = null;
            if (board.selection) {
                // The selection rasterized on the layer's own grid (PixelAdjust.coverage).
                const clip = CB.Selection.clip(board.selection, board.doc.width, board.doc.height);
                coverage = new Uint8Array(w * h);
                if (clip.cov) {
                    const sel = new ImageData(clip.rect.width, clip.rect.height);
                    for (let i = 0; i < clip.cov.length; i++) { sel.data[i * 4 + 3] = clip.cov[i]; }
                    const selCanvas = new OffscreenCanvas(clip.rect.width, clip.rect.height);
                    selCanvas.getContext('2d').putImageData(sel, 0, 0);
                    const grid = CB.Render.canvas2d(w, h);
                    CB.Affine.setOn(grid.ctx, CB.Affine.invert(toDocument));
                    grid.ctx.drawImage(selCanvas, clip.rect.x, clip.rect.y);
                    const data = grid.ctx.getImageData(0, 0, w, h).data;
                    for (let i = 0; i < coverage.length; i++) coverage[i] = data[i * 4 + 3];
                }
            }
            return { w, h, pixels, coverage, toDocument, transform, image };
        }

        // The Levels histogram from the engine: the layer's pixels weighted by alpha and the selection, or what lies
        // under an adjustment layer (levels.histogram); the board's own port when the engine cannot answer.
        async loadHistogram(edit, args) {
            const board = this.board;
            let bins = null;
            try {
                const answer = await board.engine('levels.histogram', { ...args, selection: edit.adjustmentID ? null : board.selection });
                if (answer && Array.isArray(answer.bins)) bins = answer.bins;
            } catch { /* the board's own port below */ }
            if (this.current !== edit) return;
            if (!bins) {
                if (edit.adjustmentID) {
                    const below = board.composite.below;
                    const canvas = below ? below.canvas : board.compositeCanvas();
                    const p = CB.Adjust.toPremultiplied(new Uint8Array(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data));
                    bins = CB.Adjust.histogram(p, null);
                } else bins = CB.Adjust.histogram(edit.source.pixels, edit.source.coverage);
            }
            edit.histogram = bins;
            this.refresh();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // The panel

        showPanel(edit) {
            const board = this.board;
            const title = edit.kind;
            board.panel(title, '<div class="fp-body"></div>', (el) => {
                el.classList.add('filter-panel', `fp-${edit.type}`);
                edit.element = el;
                const status = document.createElement('span');
                status.className = 'filter-status';
                el.querySelector('.buttons').insertBefore(status, el.querySelector('.ok'));
                el.querySelector('.cancel').after(Object.assign(document.createElement('span'), { className: 'spacer' }));
                el.querySelector('.buttons').before(document.createElement('hr'));
                const position = POSITIONS[PANEL_NAME[edit.type]];
                if (position) {
                    el.style.left = `${Math.max(0, Math.min(board.stageEl.clientWidth - el.offsetWidth, position.x))}px`;
                    el.style.top = `${Math.max(0, Math.min(board.stageEl.clientHeight - 40, position.y))}px`;
                }
                return () => { this.ok(); return false; };
            }, () => this.cancel());
            this.render();
            // The first open centers the panel on the canvas, once its height is known.
            if (!POSITIONS[PANEL_NAME[edit.type]] && edit.element) {
                const el = edit.element;
                el.style.left = `${Math.max(8, (board.stageEl.clientWidth - el.offsetWidth) / 2)}px`;
                el.style.top = `${Math.max(8, (board.stageEl.clientHeight - el.offsetHeight) / 2)}px`;
            }
        }

        // Rebuilds the panel's body for the current settings (rows appear and disappear with them).
        render() {
            const edit = this.current;
            if (!edit || !edit.element) return;
            const body = edit.element.querySelector('.fp-body');
            const focused = document.activeElement && body.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
            if (edit.type === 'filter') this.renderFilter(edit, body);
            else if (edit.type === 'levels') this.renderLevels(edit, body);
            else this.renderHueSaturation(edit, body);
            if (focused) {
                const again = body.querySelector(`[data-focus-key="${focused}"]`);
                if (again) again.focus();
            }
            this.refresh();
        }

        // Status, OK enabling and disabled inputs (UI/FilterSheet.swift:165-197).
        refresh() {
            const edit = this.current;
            if (!edit || !edit.element) return;
            const el = edit.element;
            const status = el.querySelector('.filter-status');
            if (status) {
                // The Filter panel says what it waits for; Levels shows a spinner alone while applying, Hue/Saturation
                // nothing (FilterSheet.swift:177-188, LevelsSheet.swift:81, HueSaturationSheet.swift:65-70).
                const working = edit.automatic && (edit.inFlight || edit.dirty);
                status.innerHTML = edit.type === 'levels' ? (edit.committing ? '<span class="spinner"></span>' : '')
                    : edit.type !== 'filter' ? '' : edit.committing ? '<span class="spinner"></span>Applying…' : working ? '<span class="spinner"></span>Working…' : '';
            }
            const error = el.querySelector('.fp-error');
            if (error) error.textContent = edit.error || '';
            el.querySelector('.ok').disabled = edit.committing || Boolean(edit.automatic && (edit.inFlight || edit.dirty || edit.error || !edit.shown));
            el.querySelectorAll('input, select, button, textarea').forEach((n) => {
                if (n.closest('.panel-title') || n.classList.contains('ok')) return;
                n.disabled = edit.committing || (n.dataset.needsHistogram === 'true' && !edit.histogram);
            });
            el.classList.toggle('committing', edit.committing);
            if (edit.type === 'levels') this.drawLevels(edit);
            if (edit.type === 'filter' && edit.element.querySelector('.fp-curves')) this.drawCurves(edit);
        }

        // The footer rows every panel shares: Preview, the error line, "Limited to the selection".
        footerHTML(edit, { previewRow = true } = {}) {
            return `${previewRow ? `<label class="check fp-row-span"><input type="checkbox" class="fp-preview" ${edit.preview ? 'checked' : ''}> Preview</label>` : ''}
                <div class="panel-error cr-error fp-error fp-row-span"></div>
                ${edit.limited ? '<div class="panel-hint fp-row-span fp-limited">Limited to the selection</div>' : ''}`;
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Filter panel body (UI/FilterSheet.swift)

        renderFilter(edit, body) {
            const s = edit.settings;
            const controls = (FILTERS[edit.kind] || []).filter((c) => !c.visible || c.visible(s));
            body.innerHTML = `<div class="fp-grid">${controls.map((c, i) => this.controlHTML(c, s, i)).join('')}${this.footerHTML(edit)}</div>`;
            controls.forEach((c, i) => this.bindControl(edit, c, body.querySelector(`[data-index="${i}"]`)));
            this.bindFooter(edit, body);
            edit.visibleKeys = controls.map((c) => c.key || c.type).join('|');
        }

        controlHTML(c, s, i) {
            const help = c.help ? ` title="${escape(c.help)}"` : '';
            switch (c.type) {
                case 'slider': {
                    const v = get(s, c.key), lo = c.log ? Math.log(c.min) : c.min, hi = c.log ? Math.log(c.max) : c.max;
                    const stops = c.track ? c.track(s) : null;
                    const track = stops ? ` colored" style="--track: linear-gradient(to right, ${stops.join(', ')})` : '';
                    const tip = c.track ? `${c.label}. Double-click to reset.` : '';
                    return `<div class="fp-slider" data-index="${i}"${help}>
                        <label class="fp-title">${escape(c.label)}</label>
                        <input type="range" class="fp-range${track}" min="${lo}" max="${hi}" step="any" value="${c.log ? Math.log(Math.max(c.min, v)) : v}"${tip ? ` title="${escape(tip)}" aria-label="${escape(tip)}"` : ` aria-label="${escape(c.label)}"`}>
                        <input class="num fp-field" data-focus-key="${c.key}" value="${fieldText(v, c.decimals)}" aria-label="${escape(c.label)}">
                        <span class="unit">${escape(c.unit)}</span></div>`;
                }
                case 'toggle':
                    return `<label class="check fp-row-span" data-index="${i}"${help}><input type="checkbox" ${get(s, c.key) ? 'checked' : ''}> ${escape(c.label)}</label>`;
                case 'segmented': {
                    const value = get(s, c.key);
                    return `<div class="fp-row-span fp-seg-row${c.fill ? ' fill' : ''}" data-index="${i}"${help}>${c.label ? `<span>${escape(c.label)}</span>` : ''}
                        <span class="segmented">${c.options.map(([v, t]) => `<button data-value='${JSON.stringify(v)}' class="${v === value ? 'on' : ''}">${escape(t)}</button>`).join('')}</span></div>`;
                }
                case 'menu': {
                    const value = get(s, c.key);
                    const options = c.groups.map((g, gi) => (gi ? '<option disabled>──────────</option>' : '') + g.map(([v, t]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${escape(t)}</option>`).join('')).join('');
                    return `<label class="fp-row-span fp-menu-row${c.fixed ? ' fixed' : ''}" data-index="${i}"${help}><span>${escape(c.label)}</span><select class="pop" data-focus-key="${c.key}">${options}</select></label>`;
                }
                case 'swatch':
                    return `<div class="fp-row-span fp-swatch-row" data-index="${i}"><span style="width:${c.labelWidth || 0}px">${escape(c.label)}</span>
                        <button class="fp-swatch" title="${escape(c.help)}" aria-label="${escape(c.label)}" style="background:${css(get(s, c.key))}"></button></div>`;
                case 'swatches':
                    return `<div class="fp-row-span fp-swatch-row" data-index="${i}">${c.items.map((item, k) => `<span${k ? ' style="margin-left:10px"' : ''}>${escape(item.label)}</span>
                        <button class="fp-swatch" data-item="${k}" title="${escape(item.help)}" aria-label="${escape(item.label)}" style="background:${css(get(s, item.key))}"></button>`).join('')}</div>`;
                case 'text':
                    return `<div class="fp-row-span fp-text ${c.tone || 'body'}" data-index="${i}">${escape(c.text)}</div>`;
                case 'textField':
                    return `<label class="fp-row-span fp-text-row" data-index="${i}"${help}><span>${escape(c.label)}</span><input class="fp-chars${c.monospaced ? ' mono' : ''}" data-focus-key="${c.key}" value="${escape(get(s, c.key))}"></label>`;
                case 'heading':
                    return `<div class="fp-row-span fp-heading" data-index="${i}">${escape(c.text)}</div>`;
                case 'curves':
                    return `<div class="fp-row-span fp-curves" data-index="${i}">
                        <select class="pop fp-channel" aria-label="Channel">${['RGB', 'Red', 'Green', 'Blue'].map((ch) => `<option ${s.curves.channel === ch ? 'selected' : ''}>${ch}</option>`).join('')}</select>
                        <canvas class="fp-graph"></canvas>
                        <div class="caption fp-hint">Click to add a point. Drag to adjust.</div>
                        <div class="fp-curve-row"><span class="fp-readout"></span><span class="spacer"></span><button class="pill fp-remove">Remove point</button></div>
                        <div><button class="pill fp-reset-curve">Reset curve</button></div></div>`;
                case 'gradientMap': {
                    const g = s.gradientMap, [dark, light] = g.reversed ? [g.highlights, g.shadows] : [g.shadows, g.highlights];
                    return `<div class="fp-row-span fp-gradient-map" data-index="${i}">
                        <div class="fp-gradient-bar" aria-hidden="true" style="background:linear-gradient(to right, ${css(dark)}, ${css(light)})"></div>
                        <div class="fp-gm-swatches">
                            <span><button class="fp-swatch" data-end="shadows" title="Choose the shadows color" aria-label="Shadows color" style="background:${css(g.shadows)}"></button> Shadows</span>
                            <span><button class="fp-swatch" data-end="highlights" title="Choose the highlights color" aria-label="Highlights color" style="background:${css(g.highlights)}"></button> Highlights</span>
                        </div>
                        <label class="check"><input type="checkbox" class="fp-reverse" ${g.reversed ? 'checked' : ''}> Reverse</label></div>`;
                }
                default: return '';
            }
        }

        bindControl(edit, c, el) {
            if (!el) return;
            switch (c.type) {
                case 'slider': this.bindSlider(edit, c, el); break;
                case 'toggle': el.querySelector('input').addEventListener('change', (e) => this.change(set(edit.settings, c.key, e.target.checked))); break;
                case 'segmented':
                    el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => this.change(set(edit.settings, c.key, JSON.parse(b.dataset.value)))));
                    break;
                case 'menu': el.querySelector('select').addEventListener('change', (e) => this.change(set(edit.settings, c.key, e.target.value))); break;
                case 'swatch': el.querySelector('.fp-swatch').addEventListener('click', () => this.pickColor(edit, c.key, c.pickerTitle)); break;
                case 'swatches':
                    el.querySelectorAll('.fp-swatch').forEach((b) => b.addEventListener('click', () => { const item = c.items[Number(b.dataset.item)]; this.pickColor(edit, item.key, item.pickerTitle); }));
                    break;
                case 'textField': el.querySelector('input').addEventListener('input', (e) => this.change(set(edit.settings, c.key, e.target.value.replace(/\n/g, '')), { keepFocus: true })); break;
                case 'curves': this.bindCurves(edit, el); break;
                case 'gradientMap':
                    el.querySelectorAll('.fp-swatch').forEach((b) => b.addEventListener('click', () => this.pickColor(edit, `gradientMap.${b.dataset.end}`,
                        b.dataset.end === 'shadows' ? 'Color Picker (Gradient Map Shadows)' : 'Color Picker (Gradient Map Highlights)')));
                    el.querySelector('.fp-reverse').addEventListener('change', (e) => this.change(set(edit.settings, 'gradientMap.reversed', e.target.checked)));
                    break;
                default: break;
            }
        }

        // A slider row (UI/FilterSheet.swift:346-375): the title scrubs 10^-decimals per point, unrounded; the slider
        // (logarithmic where marked) rounds to the decimals; the field keeps what is typed. A colored track resets on a
        // double-click of the title or the knob.
        bindSlider(edit, c, el) {
            const step = Math.pow(10, c.decimals);
            const title = el.querySelector('.fp-title'), range = el.querySelector('.fp-range'), field = el.querySelector('.fp-field');
            const reset = () => { if (c.track) this.change(set(edit.settings, c.key, get(defaultSettings(), c.key))); };
            range.addEventListener('input', () => {
                const position = Number(range.value);
                this.change(set(edit.settings, c.key, swiftRound((c.log ? Math.exp(position) : position) * step) / step), { keepFocus: true });
            });
            range.addEventListener('dblclick', (e) => {
                // Only on the knob, as CameraRawSlider's.
                const r = range.getBoundingClientRect(), position = (Number(range.value) - Number(range.min)) / (Number(range.max) - Number(range.min));
                if (Math.abs(e.clientX - (r.left + 8 + position * (r.width - 16))) <= 9) reset();
            });
            title.addEventListener('dblclick', reset);
            title.addEventListener('pointerdown', (e) => {
                if (edit.committing) return;
                title.setPointerCapture(e.pointerId);
                const start = e.clientX, from = get(edit.settings, c.key);
                title.onpointermove = (m) => {
                    if (m.clientX === start) return;
                    this.change(set(edit.settings, c.key, Math.min(c.max, Math.max(c.min, from + (m.clientX - start) / step))), { keepFocus: true });
                };
                title.onpointerup = () => { title.onpointermove = null; title.onpointerup = null; };
            });
            field.addEventListener('change', () => {
                const v = parseField(field.value);
                if (Number.isFinite(v) && field.value.trim()) this.change(set(edit.settings, c.key, v));
                else this.render();
            });
            field.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    e.stopPropagation();
                    const v = (Number.isFinite(parseField(field.value)) ? parseField(field.value) : get(edit.settings, c.key)) + (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
                    this.change(set(edit.settings, c.key, v));
                }
            });
        }

        bindFooter(edit, body) {
            const preview = body.querySelector('.fp-preview');
            if (preview) preview.addEventListener('change', (e) => this.setPreview(e.target.checked));
        }

        // Updates the values shown without rebuilding (a drag keeps its slider); rebuilds when rows come or go.
        sync(edit) {
            if (!edit.element) return;
            if (edit.type !== 'filter') { this.render(); return; }
            const s = edit.settings;
            const controls = (FILTERS[edit.kind] || []).filter((c) => !c.visible || c.visible(s));
            if (controls.map((c) => c.key || c.type).join('|') !== edit.visibleKeys) { this.render(); return; }
            const body = edit.element.querySelector('.fp-body');
            controls.forEach((c, i) => {
                const el = body.querySelector(`[data-index="${i}"]`);
                if (!el) return;
                if (c.type === 'slider') {
                    const v = get(s, c.key), range = el.querySelector('.fp-range'), field = el.querySelector('.fp-field');
                    if (document.activeElement !== range) range.value = c.log ? Math.log(Math.max(c.min, v)) : v;
                    if (document.activeElement !== field) field.value = fieldText(v, c.decimals);
                    if (c.track) range.style.setProperty('--track', `linear-gradient(to right, ${c.track(s).join(', ')})`);
                } else if (c.type === 'toggle') el.querySelector('input').checked = Boolean(get(s, c.key));
                else if (c.type === 'segmented') el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', JSON.parse(b.dataset.value) === get(s, c.key)));
                else if (c.type === 'menu') { const sel = el.querySelector('select'); if (document.activeElement !== sel) sel.value = get(s, c.key); }
                else if (c.type === 'swatch') el.querySelector('.fp-swatch').style.background = css(get(s, c.key));
                else if (c.type === 'swatches') el.querySelectorAll('.fp-swatch').forEach((b) => { b.style.background = css(get(s, c.items[Number(b.dataset.item)].key)); });
                else if (c.type === 'gradientMap') {
                    const g = s.gradientMap, [dark, light] = g.reversed ? [g.highlights, g.shadows] : [g.shadows, g.highlights];
                    el.querySelector('.fp-gradient-bar').style.background = `linear-gradient(to right, ${css(dark)}, ${css(light)})`;
                    el.querySelectorAll('.fp-swatch').forEach((b) => { b.style.background = css(g[b.dataset.end]); });
                    el.querySelector('.fp-reverse').checked = g.reversed;
                } else if (c.type === 'curves') {
                    const sel = el.querySelector('.fp-channel');
                    if (document.activeElement !== sel) sel.value = s.curves.channel;
                }
            });
            this.refresh();
        }

        // A filter color through the app's color picker (ColorPalette.swift:141-221): the canvas follows the working
        // color, OK keeps it, Cancel restores it; picking alone is never an undo step.
        pickColor(edit, key, title) {
            const board = this.board;
            if (edit.committing || board.picker.isOpen) return;
            const original = get(edit.settings, key);
            const toColor = (c) => ({ red: c[0], green: c[1], blue: c[2] });
            board.picker.open({
                title, color: [original.red, original.green, original.blue],
                onChange: (c) => { if (this.current === edit) this.change(set(edit.settings, key, toColor(c)), { keepFocus: true }); },
                onCommit: (c) => { if (this.current === edit) this.change(set(edit.settings, key, toColor(c))); },
                onCancel: () => { if (this.current === edit) this.change(set(edit.settings, key, original)); },
            });
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Curves controls (UI/CurvesControls.swift)

        bindCurves(edit, el) {
            const canvas = el.querySelector('.fp-graph');
            edit.curveUI = edit.curveUI || { selected: null, dragging: null };
            el.querySelector('.fp-channel').addEventListener('change', (e) => {
                edit.curveUI.selected = edit.curveUI.dragging = null;
                this.change(set(edit.settings, 'curves.channel', e.target.value));
            });
            const index = () => ['RGB', 'Red', 'Green', 'Blue'].indexOf(edit.settings.curves.channel);
            canvas.addEventListener('pointerdown', (e) => {
                if (edit.committing) return;
                canvas.setPointerCapture(e.pointerId);
                const handle = (m) => {
                    const r = canvas.getBoundingClientRect();
                    const x = Math.min(255, Math.max(0, ((m.clientX - r.left) / r.width) * 255));
                    const y = Math.min(255, Math.max(0, 255 - ((m.clientY - r.top) / r.height) * 255));
                    const ui = edit.curveUI, c = index();
                    let p = edit.settings.curves.channels[c].map((q) => ({ ...q }));
                    if (ui.dragging === null) {
                        let nearest = -1, best = Infinity;
                        p.forEach((q, k) => { const d = Math.hypot(q.x - x, q.y - y); if (d < best) { best = d; nearest = k; } });
                        if (nearest >= 0 && best < 14) ui.dragging = nearest;
                        else if (p.length < 32 && x > 1 && x < 254 && p.every((q) => Math.abs(q.x - x) > 1)) {
                            p.push({ x, y });
                            p.sort((a, b) => a.x - b.x);
                            ui.dragging = p.findIndex((q) => q.x === x);
                        }
                    }
                    const i = ui.dragging;
                    if (i === null || i < 0 || i >= p.length) { if (p.length !== edit.settings.curves.channels[c].length) this.change(set(edit.settings, `curves.channels.${c}`, p)); return; }
                    ui.selected = i;
                    p[i].y = y;
                    if (i > 0 && i < p.length - 1) p[i].x = Math.min(p[i + 1].x - 1, Math.max(p[i - 1].x + 1, x));
                    this.change(set(edit.settings, `curves.channels.${c}`, p), { keepFocus: true });
                };
                handle(e);
                canvas.onpointermove = handle;
                canvas.onpointerup = () => { canvas.onpointermove = null; canvas.onpointerup = null; edit.curveUI.dragging = null; };
            });
            el.querySelector('.fp-remove').addEventListener('click', () => {
                const ui = edit.curveUI, c = index(), p = edit.settings.curves.channels[c];
                if (ui.selected !== null && ui.selected > 0 && ui.selected < p.length - 1) {
                    const next = p.filter((_, k) => k !== ui.selected);
                    ui.selected = null;
                    this.change(set(edit.settings, `curves.channels.${c}`, next));
                }
            });
            el.querySelector('.fp-reset-curve').addEventListener('click', () => {
                edit.curveUI.selected = null;
                this.change(set(edit.settings, `curves.channels.${index()}`, [{ x: 0, y: 0 }, { x: 255, y: 255 }]));
            });
        }

        drawCurves(edit) {
            const el = edit.element.querySelector('.fp-curves');
            if (!el) return;
            const canvas = el.querySelector('.fp-graph'), dpr = window.devicePixelRatio || 1;
            const w = canvas.clientWidth || 332, h = 260;
            if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
            const ctx = canvas.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            ctx.fillStyle = 'rgba(0,0,0,0.35)';
            ctx.fillRect(0, 0, w, h);
            ctx.strokeStyle = 'rgba(255,255,255,0.12)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let i = 0; i <= 4; i++) {
                const f = i / 4;
                ctx.moveTo(f * w, 0); ctx.lineTo(f * w, h);
                ctx.moveTo(0, f * h); ctx.lineTo(w, f * h);
            }
            ctx.stroke();
            const c = ['RGB', 'Red', 'Green', 'Blue'].indexOf(edit.settings.curves.channel), points = edit.settings.curves.channels[c];
            const pos = (x, y) => [(x / 255) * w, (1 - y / 255) * h];
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let x = 0; x <= 255; x++) {
                const [px, py] = pos(x, CB.Adjust.curveValue(points, x));
                if (x === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.stroke();
            const ui = edit.curveUI || {};
            const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0a84ff';
            points.forEach((q, i) => {
                const [px, py] = pos(q.x, q.y);
                ctx.fillStyle = ui.selected === i ? accent : '#fff';
                ctx.beginPath();
                ctx.arc(px, py, 4, 0, Math.PI * 2);
                ctx.fill();
            });
            const selected = ui.selected !== null && ui.selected !== undefined && points[ui.selected];
            el.querySelector('.fp-readout').textContent = selected ? `Input ${Math.trunc(selected.x)} · Output ${Math.trunc(selected.y)}` : '';
            el.querySelector('.fp-remove').disabled = edit.committing || !selected || ui.selected === 0 || ui.selected === points.length - 1;
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Levels panel (UI/LevelsSheet.swift)

        renderLevels(edit, body) {
            const s = edit.settings, cur = s.ranges[['RGB', 'Red', 'Green', 'Blue'].indexOf(s.channel)];
            const field = (name, key, decimals) => `<div class="lv-field"><label class="caption lv-scrub" data-key="${key}">${name}</label>
                <input class="num" data-key="${key}" data-focus-key="lv-${key}" value="${fieldText(cur[key], decimals, true)}" aria-label="${name}"></div>`;
            const caption = edit.adjustmentID ? 'Underlying pixels · alpha-weighted histogram'
                : edit.limited ? 'Original pixels · selection and alpha-weighted histogram' : 'Original pixels · alpha-weighted histogram';
            body.innerHTML = `
                <select class="pop lv-channel" aria-label="Channel">${['RGB', 'Red', 'Green', 'Blue'].map((c) => `<option ${s.channel === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
                <div class="lv-graph">
                    <canvas class="lv-histogram" title="Linear histogram with automatic vertical scaling. Tall spikes may extend beyond the graph; all tones from 0 to 255 remain included." aria-label="Original ${s.channel} histogram"></canvas>
                    <div class="caption lv-loading">Loading histogram…</div>
                    <div class="lv-handles lv-input"></div>
                </div>
                <div class="lv-fields">${field('Input black', 'black', 0)}<span class="spacer"></span>${field('Gamma', 'gamma', 2)}<span class="spacer"></span>${field('Input white', 'white', 0)}</div>
                <div class="lv-graph"><div class="lv-output-bar"></div><div class="lv-handles lv-output"></div></div>
                <div class="lv-fields">${field('Output black', 'outputBlack', 0)}<span class="spacer"></span>${field('Output white', 'outputWhite', 0)}</div>
                <div class="lv-sample"><span class="caption">Sample</span>${['Black', 'Gray', 'White'].map((m) => `<button class="pill lv-eyedropper${edit.sampleMode === m ? ' on' : ''}" data-mode="${m}">${CB.icon('pipette')}${m}</button>`).join('')}</div>
                ${edit.sampleMode ? `<div class="caption">Click the original layer to set ${edit.sampleMode.toLowerCase()}. Click the eyedropper again to stop.</div>` : ''}
                <div class="lv-auto"><span class="caption">Auto</span><div>${['Contrast', 'Color', 'Color + neutral midtones'].map((m) => `<button class="pill lv-auto-button" data-needs-histogram="true" data-mode="${m}">${m}</button>`).join('')}</div></div>
                <div class="lv-row"><label class="check"><input type="checkbox" class="fp-preview" ${edit.preview ? 'checked' : ''}> Preview</label><span class="spacer"></span><button class="pill lv-reset">Reset</button></div>
                <div class="caption">${caption}</div>`;
            body.querySelector('.lv-channel').addEventListener('change', (e) => this.change({ ...clone(s), channel: e.target.value }));
            this.bindFooter(edit, body);
            const writeRange = (key, value) => {
                const next = clone(edit.settings), index = ['RGB', 'Red', 'Green', 'Blue'].indexOf(next.channel);
                next.ranges[index] = CB.Adjust.normalizedRange({ ...next.ranges[index], [key]: value });
                this.change(next, { keepFocus: true });
            };
            body.querySelectorAll('.lv-field input').forEach((input) => {
                input.addEventListener('change', () => {
                    const v = parseField(input.value);
                    if (Number.isFinite(v) && input.value.trim()) writeRange(input.dataset.key, v);
                    else this.render();
                });
            });
            body.querySelectorAll('.lv-scrub').forEach((label) => label.addEventListener('pointerdown', (e) => {
                if (edit.committing) return;
                label.setPointerCapture(e.pointerId);
                const key = label.dataset.key, gamma = key === 'gamma';
                const index = ['RGB', 'Red', 'Green', 'Blue'].indexOf(edit.settings.channel);
                const start = e.clientX, from = edit.settings.ranges[index][key];
                label.onpointermove = (m) => {
                    if (m.clientX === start) return;
                    const v = from + (m.clientX - start) * (gamma ? 0.01 : 1);
                    writeRange(key, gamma ? Math.min(9.99, Math.max(0.1, v)) : Math.min(255, Math.max(0, v)));
                };
                label.onpointerup = () => { label.onpointermove = null; label.onpointerup = null; };
            }));
            this.bindLevelHandles(edit, body.querySelector('.lv-input'), false);
            this.bindLevelHandles(edit, body.querySelector('.lv-output'), true);
            body.querySelectorAll('.lv-eyedropper').forEach((b) => b.addEventListener('click', () => {
                edit.sampleMode = edit.sampleMode === b.dataset.mode ? null : b.dataset.mode;
                this.render();
                this.board.view.cursor();
            }));
            body.querySelectorAll('.lv-auto-button').forEach((b) => b.addEventListener('click', () => {
                if (!edit.histogram || edit.committing) return;
                edit.sampleMode = null;
                this.change(autoLevels(b.dataset.mode, edit.histogram));
            }));
            body.querySelector('.lv-reset').addEventListener('click', () => { edit.sampleMode = null; this.change(CB.Adjust.defaultLevels()); });
        }

        // The triangles under the histogram and the output bar (LevelsSheet.swift:115-145).
        bindLevelHandles(edit, strip, output) {
            const names = output ? ['Output black', 'Output white'] : ['Input black', 'Gamma', 'Input white'];
            strip.innerHTML = names.map((n, i) => `<button class="lv-handle ${i === 0 ? 'black' : i === names.length - 1 ? 'white' : 'gray'}" data-index="${i}" aria-label="${n}"></button>`).join('');
            strip.querySelectorAll('.lv-handle').forEach((handle) => handle.addEventListener('pointerdown', (e) => {
                if (edit.committing) return;
                e.preventDefault();
                handle.setPointerCapture(e.pointerId);
                const index = Number(handle.dataset.index);
                const move = (m) => {
                    const r = strip.getBoundingClientRect();
                    const x = Math.min(255, Math.max(0, ((m.clientX - r.left) / r.width) * 255));
                    const next = clone(edit.settings), c = ['RGB', 'Red', 'Green', 'Blue'].indexOf(next.channel), range = { ...next.ranges[c] };
                    if (output) { if (index === 0) range.outputBlack = swiftRound(x); else range.outputWhite = swiftRound(x); }
                    else if (index === 0) range.black = Math.min(range.white - 1, swiftRound(x));
                    else if (index === 2) range.white = Math.max(range.black + 1, swiftRound(x));
                    else {
                        const fraction = Math.min(0.999, Math.max(0.001, (x - range.black) / (range.white - range.black)));
                        range.gamma = Math.log(fraction) / Math.log(0.5);
                    }
                    next.ranges[c] = CB.Adjust.normalizedRange(range);
                    this.change(next, { keepFocus: true });
                };
                move(e);
                handle.onpointermove = move;
                handle.onpointerup = () => { handle.onpointermove = null; handle.onpointerup = null; };
            }));
        }

        drawLevels(edit) {
            const el = edit.element;
            const canvas = el.querySelector('.lv-histogram');
            if (!canvas) return;
            const s = edit.settings, index = ['RGB', 'Red', 'Green', 'Blue'].indexOf(s.channel), cur = s.ranges[index];
            const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth || 392, h = 150;
            if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
            const ctx = canvas.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            ctx.fillStyle = 'rgba(0,0,0,0.25)';
            ctx.fillRect(0, 0, w, h);
            el.querySelector('.lv-loading').style.display = edit.histogram ? 'none' : '';
            if (edit.histogram) {
                const bins = edit.histogram[index], peak = histogramScale(bins);
                if (peak > 0) {
                    ctx.fillStyle = ['rgb(142,142,147)', 'rgb(255,69,58)', 'rgb(48,209,88)', 'rgb(10,132,255)'][index];
                    ctx.beginPath();
                    for (let i = 0; i < 256; i++) {
                        const bh = h * Math.min(1, Math.max(0, bins[i] / peak));
                        ctx.rect((i * w) / 256, h - bh, w / 256 + 0.1, bh);
                    }
                    ctx.fill();
                }
            }
            const place = (strip, values) => strip.querySelectorAll('.lv-handle').forEach((handle, i) => { handle.style.left = `${(values[i] / 255) * 100}%`; });
            place(el.querySelector('.lv-input'), [cur.black, cur.black + (cur.white - cur.black) * Math.pow(0.5, cur.gamma), cur.white]);
            place(el.querySelector('.lv-output'), [cur.outputBlack, cur.outputWhite]);
            el.querySelectorAll('.lv-field input').forEach((input) => {
                if (document.activeElement !== input) input.value = fieldText(cur[input.dataset.key], input.dataset.key === 'gamma' ? 2 : 0, true);
            });
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Hue/Saturation panel (UI/HueSaturationSheet.swift)

        renderHueSaturation(edit, body) {
            const s = edit.settings, a = s.adjustments[s.range] || { hue: 0, saturation: 0, lightness: 0 };
            const showsSpectrum = s.range !== 'Master' && !s.colorize;
            const rangeHue = Math.max(0, CB.Adjust.RANGES.indexOf(s.range) - 1) * 60;
            const reset = s.colorize ? { hue: 0, saturation: 25, lightness: 0 } : { hue: 0, saturation: 0, lightness: 0 };
            const rows = [
                { key: 'hue', label: 'Hue', min: s.colorize ? 0 : -180, max: s.colorize ? 360 : 180, unit: '°', track: TRACKS.spectrum(s.colorize ? 180 : rangeHue) },
                { key: 'saturation', label: 'Saturation', min: s.colorize ? 0 : -100, max: 100, unit: '', track: s.colorize ? TRACKS.saturation(a.hue) : s.range === 'Master' ? TRACKS.chroma() : TRACKS.saturation(rangeHue) },
                { key: 'lightness', label: 'Lightness', min: -100, max: 100, unit: '', track: TRACKS.opposing('#000', '#fff') },
            ];
            body.innerHTML = `
                <div class="hs-top">
                    <select class="pop hs-range" aria-label="Range" ${s.colorize ? 'disabled' : ''}>${CB.Adjust.RANGES.map((r) => `<option ${r === s.range ? 'selected' : ''}>${r}</option>`).join('')}</select>
                    <span class="spacer"></span>
                    ${showsSpectrum ? ['Sample', 'Add', 'Remove'].map((m) => `<button class="icon-button hs-dropper${edit.sampleMode === m ? ' armed' : ''}" data-mode="${m}" title="${HUE_SAMPLE_HELP[m]}" aria-label="${m} color">${glyph(EYEDROPPER, BADGES[m])}</button>`).join('') + '<span class="hs-divider"></span>' : ''}
                    ${s.colorize ? '' : `<button class="icon-button hs-target${edit.targeting ? ' armed' : ''}" title="Targeted adjustment: drag on the image to change that color's saturation, or its hue with Command held" aria-label="Targeted adjustment">${glyph(HAND)}</button>`}
                </div>
                ${rows.map((r) => `<div class="hs-slider" data-key="${r.key}">
                    <label class="fp-title">${r.label}</label>
                    <input type="range" class="fp-range colored" style="--track: linear-gradient(to right, ${r.track.join(', ')})" min="${r.min}" max="${r.max}" step="any" value="${a[r.key]}" title="${r.label}. Double-click to reset." aria-label="${r.label}. Double-click to reset.">
                    <input class="num" data-focus-key="hs-${r.key}" value="${fieldText(a[r.key], 0)}" aria-label="${r.label}"><span class="unit">${r.unit}</span></div>`).join('')}
                ${showsSpectrum ? `<div class="hs-spectrum">
                    <canvas class="hs-bar before"></canvas><canvas class="hs-handles"></canvas><canvas class="hs-bar after"></canvas>
                    <div class="caption mono-digits">${(s.bands[s.range] || CB.Adjust.DEFAULT_BANDS[s.range]).map((v) => `${Math.trunc(swiftRound(v))}°`).join('   ')}</div></div>
                    <label class="check"><input type="checkbox" class="hs-outside" ${s.invertRange ? 'checked' : ''}> Apply outside this range instead</label>` : ''}
                <div class="hs-row"><label class="check"><input type="checkbox" class="hs-colorize" ${s.colorize ? 'checked' : ''}> Colorize</label>
                    <label class="check"><input type="checkbox" class="fp-preview" ${edit.preview ? 'checked' : ''}> Preview</label>
                    <button class="pill hs-reset">Reset</button></div>
                ${edit.limited ? '<div class="panel-hint">Limited to the selection</div>' : ''}`;
            const write = (key, value) => {
                const next = clone(edit.settings);
                next.adjustments[next.range] = { ...(next.adjustments[next.range] || { hue: 0, saturation: 0, lightness: 0 }), [key]: value };
                this.change(next, { keepFocus: true });
            };
            body.querySelector('.hs-range').addEventListener('change', (e) => this.change({ ...clone(edit.settings), range: e.target.value }));
            rows.forEach((r) => {
                const el = body.querySelector(`.hs-slider[data-key="${r.key}"]`);
                const title = el.querySelector('.fp-title'), range = el.querySelector('.fp-range'), field = el.querySelector('.num');
                range.addEventListener('input', () => write(r.key, swiftRound(Number(range.value))));
                range.addEventListener('dblclick', (e) => {
                    const rect = range.getBoundingClientRect(), position = (Number(range.value) - r.min) / (r.max - r.min);
                    if (Math.abs(e.clientX - (rect.left + 8 + position * (rect.width - 16))) <= 9) write(r.key, reset[r.key]);
                });
                title.addEventListener('dblclick', () => write(r.key, reset[r.key]));
                title.addEventListener('pointerdown', (e) => {
                    if (edit.committing) return;
                    title.setPointerCapture(e.pointerId);
                    const start = e.clientX, from = (edit.settings.adjustments[edit.settings.range] || {})[r.key] || 0;
                    title.onpointermove = (m) => { if (m.clientX !== start) write(r.key, Math.min(r.max, Math.max(r.min, from + (m.clientX - start)))); };
                    title.onpointerup = () => { title.onpointermove = null; title.onpointerup = null; };
                });
                field.addEventListener('change', () => {
                    const v = parseField(field.value);
                    if (Number.isFinite(v) && field.value.trim()) write(r.key, v);
                    else this.render();
                });
                // Return in a field clamps the value and confirms the panel, as OK (HueSaturationSheet.swift:136-140).
                field.addEventListener('keydown', (e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    e.stopPropagation();
                    const v = parseField(field.value);
                    if (Number.isFinite(v)) write(r.key, Math.min(r.max, Math.max(r.min, v)));
                    this.ok();
                });
            });
            body.querySelectorAll('.hs-dropper').forEach((b) => b.addEventListener('click', () => {
                edit.targeting = false;
                edit.sampleMode = edit.sampleMode === b.dataset.mode ? null : b.dataset.mode;
                this.render();
                this.board.view.cursor();
            }));
            const target = body.querySelector('.hs-target');
            if (target) target.addEventListener('click', () => { edit.sampleMode = null; edit.targeting = !edit.targeting; this.render(); this.board.view.cursor(); });
            const outside = body.querySelector('.hs-outside');
            if (outside) outside.addEventListener('change', (e) => this.change({ ...clone(edit.settings), invertRange: e.target.checked }));
            // Colorize on starts at hue 0, saturation 25; off goes back to no change (HueSaturationSheet.swift:53-56).
            body.querySelector('.hs-colorize').addEventListener('change', (e) => this.change(e.target.checked ? CB.Adjust.COLORIZE_START() : CB.Adjust.hsvSettings()));
            body.querySelector('.hs-reset').addEventListener('click', () => this.change(edit.settings.colorize ? CB.Adjust.COLORIZE_START() : CB.Adjust.hsvSettings()));
            this.bindFooter(edit, body);
            if (showsSpectrum) this.drawSpectrum(edit, body.querySelector('.hs-spectrum'));
        }

        // The before and after hue bars and the band's four handles (SpectrumEditor).
        drawSpectrum(edit, el) {
            const s = edit.settings, band = s.bands[s.range] || CB.Adjust.DEFAULT_BANDS[s.range], dpr = window.devicePixelRatio || 1;
            const size = (canvas, h) => {
                const w = canvas.clientWidth || 412;
                if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
                const ctx = canvas.getContext('2d');
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.clearRect(0, 0, w, h);
                return { ctx, w };
            };
            for (const [cls, after] of [['before', false], ['after', true]]) {
                const { ctx, w } = size(el.querySelector(`.hs-bar.${cls}`), 16);
                const slice = w / 72;
                for (let k = 0; k < 72; k++) {
                    const hue = (k / 72) * 360;
                    ctx.fillStyle = hsb(after ? CB.Adjust.shiftedHue(hue, s) : hue, 1, 1);
                    ctx.fillRect(k * slice, 0, slice + 0.5, 16);
                }
            }
            const handles = el.querySelector('.hs-handles');
            const { ctx, w } = size(handles, 12);
            ctx.fillStyle = getComputedStyle(document.body).color || '#ddd';
            band.forEach((deg, i) => {
                const x = (deg / 360) * w;
                if (i === 1 || i === 2) ctx.fillRect(x - 1, 0, 2, 12); else ctx.fillRect(x - 3.5, 6 - 2.5, 7, 5);
            });
            if (!handles.dataset.bound) {
                handles.dataset.bound = 'true';
                handles.addEventListener('pointerdown', (e) => {
                    if (edit.committing) return;
                    handles.setPointerCapture(e.pointerId);
                    let dragging = null;
                    const move = (m) => {
                        const r = handles.getBoundingClientRect();
                        if (!(r.width > 0)) return;
                        const degrees = (Math.min(Math.max(0, m.clientX - r.left), r.width) / r.width) * 360;
                        const now = edit.settings, b = now.bands[now.range] || CB.Adjust.DEFAULT_BANDS[now.range];
                        if (dragging === null) {
                            const distances = b.map((hdl) => { const gap = Math.abs(hdl - degrees) % 360; return Math.min(gap, 360 - gap); });
                            dragging = distances.indexOf(Math.min(...distances));
                        }
                        const next = clone(now);
                        next.bands[next.range] = bandSetHandle(b, dragging, degrees);
                        this.change(next, { keepFocus: true });
                    };
                    move(e);
                    handles.onpointermove = move;
                    handles.onpointerup = () => { handles.onpointermove = null; handles.onpointerup = null; };
                });
            }
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Changes and previews

        // New settings from a control: the panel follows at once; the canvas through the engine (filters), the board's
        // kernels (Levels, Hue/Saturation) or the layer's own settings (adjustment layers).
        change(next, { keepFocus = false } = {}) {
            const edit = this.current;
            if (!edit || edit.committing) return;
            edit.settings = edit.adjustmentID && edit.type === 'filter' ? normalizedLayerSettings(next) : next;
            if (keepFocus) this.sync(edit); else this.render();
            if (edit.type === 'levels' && !edit.adjustmentID) this.refresh();
            this.previewChanged(edit);
        }

        setPreview(on) {
            const edit = this.current;
            if (!edit || edit.committing) return;
            edit.preview = on;
            const box = edit.element && edit.element.querySelector('.fp-preview');
            if (box) box.checked = on;
            if (!on && !edit.adjustmentID) {
                this.board.renderer.overrides.delete(edit.layerID);
                this.board.changed();
            }
            this.previewChanged(edit);
        }

        previewChanged(edit) {
            if (edit.adjustmentID) this.previewLayer(edit);
            else if (edit.type === 'filter') this.requestPreview(edit);
            else this.schedulePixels(edit);
        }

        // The adjustment layer's settings as edited (editedAdjustment, AdjustmentEditing.swift:65-98).
        editedAdjustment(edit) {
            const value = clone(edit.original), s = edit.settings;
            switch (value.kind) {
                case 'Levels': value.levels = clone(s); break;
                case 'Hue/Saturation': value.hsvSettings = CB.Adjust.hsvToManifest(s); break;
                case 'Exposure': value.exposureSettings = clone(s.exposure); break;
                case 'Gradient Map': value.gradientMapSettings = clone(s.gradientMap); break;
                case 'Grain': value.grainSettings = { ...clone(s.grain), seed: CB.Adjust.resolved(edit.original).grain.seed }; break;
                case 'Black & White': value.blackWhiteSettings = clone(s.blackWhite); break;
                case 'Color Balance': value.colorBalanceSettings = clone(s.colorBalance); break;
                case 'Gaussian Blur': value.blurRadius = s.radius; break;
                case 'Motion Blur': value.motionAngle = s.angle; value.motionDistance = s.distance; break;
                case 'Add Noise': value.noiseAmount = s.amount; value.noiseGaussian = s.gaussian; value.noiseMonochromatic = s.monochromatic; break;
                default: value.curves = clone(s.curves);
            }
            return value;
        }

        // previewAdjustmentEditing (AdjustmentEditing.swift:100-106): the edited value, or the original with Preview off,
        // written to the layer unless it is not valid (updateAdjustment refuses it, the layer keeps what it had).
        previewLayer(edit) {
            const board = this.board, record = board.doc.layer(edit.adjustmentID);
            if (!record) return;
            const value = edit.preview ? this.editedAdjustment(edit) : edit.original;
            if (!CB.Adjust.isValid(value)) return;
            record.adjustment = value;
            board.liveChanged();
        }

        // Levels and Hue/Saturation on a layer's own pixels: a frame at a time, the newest settings winning.
        schedulePixels(edit) {
            if (edit.frame) return;
            edit.frame = requestAnimationFrame(() => {
                edit.frame = 0;
                if (this.current !== edit) return;
                this.renderPixels(edit);
            });
        }

        // LevelsFilter.run / HueSaturationFilter.run with the selection blended in (PixelAdjust.blend), shown in place
        // of the layer; nothing while Preview is off or the settings change nothing.
        renderPixels(edit) {
            const board = this.board, src = edit.source;
            const identity = edit.type === 'levels' ? CB.Adjust.levelsIdentity(edit.settings) : CB.Adjust.hsvIdentity(edit.settings);
            if (!edit.preview || identity) {
                board.renderer.overrides.delete(edit.layerID);
                board.changed();
                return;
            }
            const out = src.pixels.slice();
            if (edit.type === 'levels') CB.Adjust.levelsApply(out, CB.Adjust.levelsTables(edit.settings), 'L' + JSON.stringify(edit.settings.ranges));
            else CB.Adjust.cubeApply(out, CB.Adjust.hsCube(edit.settings));
            if (src.coverage) {
                const orig = src.pixels;
                for (let px = 0, i = 0; px < src.coverage.length; px++, i += 4) {
                    const k = src.coverage[px];
                    if (k === 255) continue;
                    for (let c = 0; c < 4; c++) out[i + c] = Math.round((out[i + c] * k + orig[i + c] * (255 - k)) / 255);
                }
            }
            const img = new ImageData(src.w, src.h);
            CB.Adjust.toStraight(out, img.data);
            const canvas = edit.previewCanvas || (edit.previewCanvas = new OffscreenCanvas(src.w, src.h));
            canvas.getContext('2d').putImageData(img, 0, 0);
            board.renderer.overrides.set(edit.layerID, { canvas, toDocument: src.toDocument });
            board.changed();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // The engine's filter edit (filters.md 18-19)

        async begin(edit) {
            const board = this.board;
            edit.inFlight = true;
            edit.dirty = false;
            this.refresh();
            let answer;
            try {
                answer = await board.engine('filter.begin', {
                    kind: edit.kind, settings: edit.settings, selection: board.selection, activeLayerID: edit.layerID,
                    foreground: board.colors.fg, background: board.colors.bg,
                }, { files: { out: 'png' } });
            } catch (error) {
                answer = { error: error.message, files: {} };
            }
            edit.inFlight = false;
            if (this.current !== edit) {
                if (answer.edit) board.engine('filter.cancel', { edit: answer.edit }, { stateless: true }).catch(() => {});
                return;
            }
            edit.id = answer.edit || null;
            // A change made while the edit was opening goes to the engine next; otherwise the engine's normalized settings
            // (with the default Progressive Blur line and the Gradient Map ends) are what the panel shows.
            await this.receive(edit, answer);
            if (edit.dirty && edit.id) this.pump(edit);
        }

        requestPreview(edit) {
            if (!edit || edit.committing) return;
            edit.dirty = true;
            this.refresh();
            if (edit.inFlight || !edit.id) return;
            this.pump(edit);
        }

        // One request in flight, the newest settings next (renderFilterPreview's coalescing, Filters.swift:792-844).
        async pump(edit) {
            const board = this.board;
            while (edit.dirty && this.current === edit && !edit.committing && edit.id) {
                edit.dirty = false;
                edit.inFlight = true;
                this.refresh();
                const preview = edit.preview;
                let answer;
                try {
                    answer = await board.engine('filter.update', { edit: edit.id, settings: edit.settings, preview }, { files: preview ? { out: 'png' } : {}, stateless: true });
                } catch (error) {
                    answer = { error: error.message, files: {} };
                }
                edit.inFlight = false;
                if (this.current !== edit) return;
                if (/no longer open|stopped/.test(answer.error || '')) {
                    // The engine stops after a while unused and forgets open edits: open it again with these settings.
                    edit.id = null;
                    await this.begin(edit);
                    return;
                }
                await this.receive(edit, answer);
            }
            this.refresh();
        }

        async receive(edit, answer) {
            const board = this.board;
            edit.error = answer.error || null;
            if (answer.alert) board.toast(answer.alert);
            if (answer.settings && !edit.dirty) {
                edit.settings = answer.settings;
                this.sync(edit);
            }
            if (answer.files && answer.files.out && answer.transform) {
                const canvas = await CB.Document.decodeToCanvas(answer.files.out);
                const t = Transform.read(answer.transform, [board.doc.width, board.doc.height]);
                edit.shown = { canvas, toDocument: Transform.pixelToDocument(t, canvas.width, canvas.height) };
            } else if (!edit.preview) {
                edit.shown = null;
            }
            if (this.current !== edit) return;
            this.show(edit);
            this.refresh();
        }

        // The layer drawn from the preview while Preview is on, from its own pixels otherwise. The override places the
        // pixels only, so while a grown preview shows the layer's mask stays on the layer's old bounds
        // (LayerMask.swift:331-334).
        show(edit) {
            const board = this.board;
            if (edit.preview && edit.shown) board.renderer.overrides.set(edit.layerID, edit.shown);
            else board.renderer.overrides.delete(edit.layerID);
            board.changed();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // OK and Cancel

        // Reads a field still being typed in, since Return arrives before its change event.
        flushField() {
            const edit = this.current, active = document.activeElement;
            if (edit && edit.element && edit.element.contains(active) && active.tagName === 'INPUT' && active.type !== 'checkbox') {
                active.dispatchEvent(new Event('change'));
            }
        }

        async ok() {
            const edit = this.current, board = this.board;
            if (!edit || edit.committing) return;
            this.flushField();
            if (this.current !== edit) return;
            // A filter color still in the picker is kept (Filters.swift:862-864).
            if (board.picker.isOpen && board.picker.options && board.picker.options.onCancel) board.picker.close(true);
            if (edit.adjustmentID) { this.endEditing(edit, true); return; }
            if (edit.type === 'filter') await this.commitFilter(edit);
            else await this.commitPixels(edit);
        }

        async commitFilter(edit) {
            const board = this.board;
            if (edit.automatic && (edit.inFlight || edit.dirty || edit.error || !edit.shown)) return;
            edit.committing = true;
            edit.dirty = false;
            this.refresh();
            let result = edit.id ? await board.selectionOp('filter.commit', { edit: edit.id, settings: edit.settings }, edit.kind) : null;
            if (!result && this.current === edit) {
                // The open edit was lost (the engine restarted): apply the same settings in one go.
                result = await board.selectionOp('filter.apply', { kind: edit.kind, settings: edit.settings, activeLayerID: edit.layerID }, edit.kind);
            }
            if (this.current !== edit) return;
            if (result && result.discarded === 'stale') {
                board.toast('The layer changed on disk while the filter was open, so the filter was not applied.');
            } else if (!result || result.error || result.open) {
                edit.committing = false;
                edit.error = (result && result.error) || 'The filter could not be applied.';
                this.refresh();
                return;
            }
            if (result) {
                if (result.lastFilter !== undefined) this.lastFilter = result.lastFilter || this.lastFilter;
                if (result.filterSettings && !result.noop) this.filterSettings = result.filterSettings;
            }
            this.finish(edit);
        }

        // Levels and Hue/Saturation OK: no change does nothing; otherwise the engine applies the settings as the app
        // does, one undo step, and the preview stays until the layer's new pixels are in.
        async commitPixels(edit) {
            const board = this.board;
            const identity = edit.type === 'levels' ? CB.Adjust.levelsIdentity(edit.settings) : CB.Adjust.hsvIdentity(edit.settings);
            if (identity) { this.finish(edit); return; }
            edit.committing = true;
            this.refresh();
            const result = edit.type === 'levels'
                ? await board.selectionOp('levels.apply', { levels: edit.settings, activeLayerID: edit.layerID }, 'Levels')
                : await board.selectionOp('hueSaturation.apply', { hueSaturation: CB.Adjust.hsvToManifest(edit.settings), activeLayerID: edit.layerID }, 'Hue/Saturation');
            if (this.current !== edit) return;
            if (!result || result.error) {
                edit.committing = false;
                this.refresh();
                return;
            }
            this.finish(edit);
        }

        cancel() {
            const edit = this.current;
            if (edit && edit.committing) return false;
            if (!edit) return true;
            if (this.board.picker.isOpen && this.board.picker.options && this.board.picker.options.onCancel) this.board.picker.close(false);
            this.current = null;
            if (edit.id) this.board.engine('filter.cancel', { edit: edit.id }, { stateless: true }).catch(() => {});
            this.endEditing(edit, false);
            return true;
        }

        // Kept for older callers: the panel's Cancel.
        close() {
            return this.cancel();
        }

        finish(edit) {
            const board = this.board;
            this.remember(edit);
            this.current = null;
            if (edit.frame) cancelAnimationFrame(edit.frame);
            board.renderer.overrides.delete(edit.layerID);
            if (board.levelsEdit === edit) board.levelsEdit = null;
            board.closePanel();
            board.changed();
            board.view.cursor();
        }

        remember(edit) {
            if (edit.element) POSITIONS[PANEL_NAME[edit.type]] = { x: edit.element.offsetLeft, y: edit.element.offsetTop };
        }

        // The end of a panel without an engine commit: an adjustment layer keeps the edited settings (OK) or gets its
        // original back (Cancel); one undo step "Edit <Kind> Adjustment" when anything changed (finishAdjustmentEditing).
        endEditing(edit, commit) {
            const board = this.board;
            this.remember(edit);
            this.current = null;
            if (edit.frame) cancelAnimationFrame(edit.frame);
            if (board.levelsEdit === edit) board.levelsEdit = null;
            if (edit.adjustmentID) {
                const record = board.doc.layer(edit.adjustmentID);
                board.adjustmentEditingID = null;
                board.endLive();
                if (record) {
                    const edited = commit ? this.editedAdjustment(edit) : edit.original;
                    record.adjustment = clone(edit.original);
                    if (commit && CB.Adjust.isValid(edited)) board.edit(`Edit ${edit.original.kind} Adjustment`, () => { record.adjustment = edited; });
                }
            } else {
                board.renderer.overrides.delete(edit.layerID);
            }
            board.closePanel();
            board.changed();
            board.view.cursor();
        }

        // While an adjustment layer's editor is open the document holds its previewed settings; a save writes the
        // settings it had when the editor opened, since only OK makes the change (the app waits instead,
        // EditorSession.swift:153).
        async savingOriginals(fn) {
            const edit = this.current;
            const record = edit && edit.adjustmentID && this.board.doc.layer(edit.adjustmentID);
            if (!record) return fn();
            const shown = record.adjustment;
            record.adjustment = clone(edit.original);
            try {
                return await fn();
            } finally {
                if (this.current === edit) record.adjustment = shown;
            }
        }

        // ---------------------------------------------------------------------------------------------------------------
        // The canvas while a panel is open

        // A press on the canvas: Progressive Blur's line, the Levels and Hue/Saturation eyedroppers, targeted adjustment.
        // Returns { move, up } to follow the drag, or null when the canvas stays inert.
        canvasPress(doc, screen, e) {
            const edit = this.current;
            if (!edit || edit.committing) return null;
            if (edit.type === 'filter' && edit.kind === 'Progressive Blur' && !edit.adjustmentID) return this.progressivePress(edit, doc, screen);
            if (edit.type === 'levels' && edit.sampleMode) {
                this.sampleLevels(edit, doc);
                return { up: () => this.focusPanel() };
            }
            if (edit.type === 'hueSaturation' && edit.sampleMode) {
                this.sampleHueRange(edit, doc);
                return { up: () => this.focusPanel() };
            }
            if (edit.type === 'hueSaturation' && edit.targeting) return this.targetPress(edit, doc, screen, e);
            return null;
        }

        focusPanel() {
            const edit = this.current;
            if (edit && edit.element) edit.element.querySelector('.ok').focus();
        }

        // Progressive Blur on the canvas (EditorCanvas.swift:2488-2519): an end within 10 points is dragged, else a new
        // line starts at the press; Shift holds the dragged end to 45° steps around the other.
        progressivePress(edit, doc, screen) {
            const view = this.board.view, s = edit.settings;
            const point = (q) => (q ? { x: q[0], y: q[1] } : null);
            const start = point(s.progressiveStart), end = point(s.progressiveEnd);
            let which;
            if (end && Math.hypot(screen.x - view.toScreen(end).x, screen.y - view.toScreen(end).y) <= 10) which = 'progressiveEnd';
            else if (start && Math.hypot(screen.x - view.toScreen(start).x, screen.y - view.toScreen(start).y) <= 10) which = 'progressiveStart';
            else {
                which = 'progressiveEnd';
                this.change({ ...clone(s), progressiveStart: [doc.x, doc.y], progressiveEnd: [doc.x, doc.y] }, { keepFocus: true });
            }
            const snapped = (p, anchor) => {
                const dx = p.x - anchor[0], dy = p.y - anchor[1], length = Math.hypot(dx, dy);
                const angle = swiftRound(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
                return [anchor[0] + Math.cos(angle) * length, anchor[1] + Math.sin(angle) * length];
            };
            return {
                move: (q, _s, m) => {
                    if (!this.current || this.current !== edit || edit.committing) return;
                    const other = which === 'progressiveEnd' ? edit.settings.progressiveStart : edit.settings.progressiveEnd;
                    const value = m.shiftKey && other ? snapped(q, other) : [q.x, q.y];
                    this.change({ ...clone(edit.settings), [which]: value }, { keepFocus: true });
                },
                up: () => this.focusPanel(),
            };
        }

        // The Levels eyedroppers (sampleLevels, LevelsAutomatic.swift:68-83): the original layer's pixel (the composite
        // under an adjustment layer), unpremultiplied, sets that point for red, green and blue together.
        sampleLevels(edit, doc) {
            const board = this.board;
            if (doc.x < 0 || doc.y < 0 || doc.x >= board.doc.width || doc.y >= board.doc.height) return;
            let data;
            if (edit.adjustmentID) {
                const below = board.composite.below;
                if (!below) return;
                data = below.ctx.getImageData(Math.floor(doc.x), Math.floor(doc.y), 1, 1).data;
            } else {
                const src = edit.source, image = src.image;
                const full = Transform.pixelToDocument(src.transform, image.width, image.height);
                const pixel = CB.Affine.apply(CB.Affine.invert(full), doc.x, doc.y);
                if (pixel.x < 0 || pixel.y < 0 || pixel.x >= image.width || pixel.y >= image.height) return;
                data = image.getContext('2d').getImageData(Math.floor(pixel.x), Math.floor(pixel.y), 1, 1).data;
            }
            if (!(data[3] > 0)) return;
            this.change(levelsSampling(edit.settings, [data[0] / 255, data[1] / 255, data[2] / 255], edit.sampleMode));
        }

        // The visible composite's color at a document point (sampleCompositeColor), or null.
        compositeColor(doc) {
            const board = this.board;
            if (doc.x < 0 || doc.y < 0 || doc.x >= board.doc.width || doc.y >= board.doc.height) return null;
            const data = board.compositeCanvas().getContext('2d').getImageData(Math.floor(doc.x), Math.floor(doc.y), 1, 1).data;
            return data[3] > 0 ? [data[0] / 255, data[1] / 255, data[2] / 255] : null;
        }

        // The Hue/Saturation eyedroppers (sampleHueRange, HueSaturation.swift:582-588): re-center, widen or narrow the
        // selected range's band; a near-neutral color changes nothing.
        sampleHueRange(edit, doc) {
            const s = edit.settings, color = this.compositeColor(doc), hue = color && hueOf(color);
            if (s.range === 'Master' || s.colorize || hue === null || hue === undefined) return;
            const band = s.bands[s.range] || CB.Adjust.DEFAULT_BANDS[s.range];
            const next = clone(s);
            next.bands[s.range] = edit.sampleMode === 'Sample' ? bandCentered(band, hue) : edit.sampleMode === 'Add' ? bandInclude(band, hue) : bandExclude(band, hue);
            this.change(next);
        }

        // Targeted adjustment (HueSaturation.swift:590-616): the range that owns the sampled hue becomes the selected
        // one; dragging sets its saturation (its hue with ⌘) to the start value plus half the horizontal points moved.
        targetPress(edit, doc, screen) {
            const s = edit.settings, color = this.compositeColor(doc), hue = color && hueOf(color);
            if (s.colorize || hue === null || hue === undefined) return { up: () => this.focusPanel() };
            const ranges = CB.Adjust.RANGES.slice(1);
            let range = ranges[0], best = -1;
            for (const r of ranges) { const w = CB.Adjust.hsWeight(s, r, hue); if (w > best) { best = w; range = r; } }
            const start = s.adjustments[range] || { hue: 0, saturation: 0, lightness: 0 };
            this.change({ ...clone(s), range });
            return {
                move: (_q, p, m) => {
                    if (this.current !== edit || edit.committing) return;
                    const delta = p.x - screen.x, next = clone(edit.settings);
                    const a = { ...(next.adjustments[range] || { hue: 0, saturation: 0, lightness: 0 }) };
                    if (m.metaKey) a.hue = Math.min(180, Math.max(-180, start.hue + delta / 2));
                    else a.saturation = Math.min(100, Math.max(-100, start.saturation + delta / 2));
                    next.adjustments[range] = a;
                    this.change(next, { keepFocus: true });
                },
                up: () => this.focusPanel(),
            };
        }

        cursor() {
            const edit = this.current;
            if (!edit) return null;
            if ((edit.type === 'levels' || edit.type === 'hueSaturation') && edit.sampleMode) return CB.SelectionCursors.eyedropper('Sample');
            if (edit.type === 'hueSaturation' && edit.targeting) return 'ew-resize';
            return null;
        }

        // Progressive Blur's line over the canvas (TransformOverlay.swift:406-448), whether Preview is on or not.
        drawOverlay(ctx) {
            const edit = this.current;
            if (!edit || edit.type !== 'filter' || edit.kind !== 'Progressive Blur' || edit.adjustmentID) return;
            const s = edit.settings;
            if (!s.progressiveStart || !s.progressiveEnd) return;
            const view = this.board.view;
            const a = view.toScreen({ x: s.progressiveStart[0], y: s.progressiveStart[1] }), b = view.toScreen({ x: s.progressiveEnd[0], y: s.progressiveEnd[1] });
            ctx.save();
            if (s.progressiveRadial) {
                const radius = Math.hypot(b.x - a.x, b.y - a.y);
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.arc(a.x, a.y, radius, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 2; ctx.stroke();
                ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1; ctx.stroke();
                ctx.setLineDash([]);
            }
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 3; ctx.stroke();
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
            // The sharp start: white; the blurred end: gray with a white ring.
            ctx.beginPath();
            ctx.arc(a.x, a.y, 6, 0, Math.PI * 2);
            ctx.fillStyle = '#fff'; ctx.fill();
            ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
            ctx.beginPath();
            ctx.arc(b.x, b.y, 6, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(153,153,153,0.9)'; ctx.fill();
            ctx.beginPath();
            ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
            ctx.beginPath();
            ctx.arc(b.x, b.y, 6, 0, Math.PI * 2);
            ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
            ctx.restore();
        }

        // ---------------------------------------------------------------------------------------------------------------
        // Last Filter (Filters.swift:746-759)

        canRepeatLastFilter() {
            return Boolean(this.lastFilter) && (this.lastFilter === 'Vignette' ? this.canVignette() : this.canAdjustColors());
        }

        async repeatLastFilter() {
            const board = this.board;
            if (!this.canRepeatLastFilter()) return;
            if (board.selectTools.floating) await board.selectTools.commitFloating();
            await board.resolvePending('edit');
            const kind = this.lastFilter;
            // Camera Raw's settings are its own (camera-raw.md 20.3).
            if (kind === 'Camera Raw Filter' && board.cameraRaw) { await board.cameraRaw.repeat(); return; }
            const result = await board.selectionOp('filter.repeat', { kind, settings: this.filterSettings || defaultSettings() }, kind);
            if (result && result.filterSettings && result.saved) this.filterSettings = result.filterSettings;
        }
    }

    CB.FilterPanel = FilterPanel;
    CB.Filters = { FILTERS, FILTER_MENU, IMAGE_KINDS, AUTOMATIC, defaultSettings, normalizedLayerSettings, autoLevels, levelsSampling, histogramScale,
        bandCentered, bandInclude, bandExclude, bandSetHandle, hueOf };
})();
