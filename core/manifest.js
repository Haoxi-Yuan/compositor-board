'use strict';
// The `.comp` manifest: Compositor's load-time validation (upstream IO/ProjectStore.swift, Document/LayerGroups.swift,
// Document/LiveLayerMask.swift; checklist and line references in docs/port-specs/manifest.md), plus the layer edits the
// MCP tools make. Compositor refuses an invalid project without any message, so every write is checked here first and
// the first problem is reported in words.

const fs = require('fs');
const path = require('path');
const io = require('./package-io');
const png = require('./png');

const CURRENT_VERSION = 14;
const BLEND_MODES = [
    'Normal', 'Darken', 'Multiply', 'Color Burn', 'Linear Burn', 'Lighten', 'Screen', 'Color Dodge', 'Linear Dodge (Add)',
    'Overlay', 'Soft Light', 'Hard Light', 'Vivid Light', 'Linear Light', 'Pin Light', 'Hard Mix', 'Difference',
    'Exclusion', 'Subtract', 'Divide', 'Hue', 'Saturation', 'Color', 'Luminosity',
];
const SAMPLING = ['Nearest', 'Smooth', 'High quality'];
const ADJUSTMENT_KINDS = ['Hue/Saturation', 'Levels', 'Curves', 'Exposure', 'Gradient Map', 'Grain', 'Add Noise', 'Gaussian Blur', 'Motion Blur', 'Invert', 'Black & White', 'Color Balance'];
const SHAPE_KINDS = ['Rectangle', 'Ellipse', 'Line'];
const NEW_CANVAS = { width: 1920, height: 1080, resolution: 72 };
const MAX_SIDE = 30000;
const PIXEL_BUDGET = 200000000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => isNumber(v) && Number.isInteger(v);
const isPair = (v) => Array.isArray(v) && v.length >= 2 && isNumber(v[0]) && isNumber(v[1]);

function transformProblem(t, label) {
    if (!t || typeof t !== 'object') return `${label} is missing`;
    for (const key of ['origin', 'size']) if (!isPair(t[key])) return `${label}.${key} must be [x, y] numbers`;
    if (!isNumber(t.rotation)) return `${label}.rotation must be a number`;
    if (typeof t.flipX !== 'boolean' || typeof t.flipY !== 'boolean') return `${label}.flipX/flipY must be true or false`;
    if (!SAMPLING.includes(t.sampling)) return `${label}.sampling must be one of ${SAMPLING.join(', ')}`;
    const [w, h] = t.size, [x, y] = t.origin;
    if (!(w >= 1 && w <= 300000 && h >= 1 && h <= 300000)) return `${label}.size must be 1 to 300000 (LayerTransform.isValid)`;
    if (Math.abs(x) > 1000000 || Math.abs(y) > 1000000) return `${label}.origin must be within 1000000 (LayerTransform.isValid)`;
    return null;
}

function shapeProblem(shape) {
    if (!SHAPE_KINDS.includes(shape.kind)) return `shape.kind must be one of ${SHAPE_KINDS.join(', ')}`;
    for (const key of ['red', 'green', 'blue', 'cornerRadius']) if (!isNumber(shape[key])) return `shape.${key} is required`;
    if (shape.smoothing !== undefined && typeof shape.smoothing !== 'boolean') return 'shape.smoothing must be true or false';
    for (const key of ['start', 'end']) if (shape[key] !== undefined && !isPair(shape[key])) return `shape.${key} must be [x, y]`;
    return null;
}

// Every reason Compositor would refuse `manifest`. `images` maps each referenced file to pngInfo(), {exr: true}, or
// null when the file is missing.
function validate(manifest, { images } = {}) {
    const problems = [];
    const add = (text) => problems.push(text);
    if (!manifest || typeof manifest !== 'object') return ['manifest.json is not a JSON object'];
    if (manifest.format !== io.FORMAT) add(`format must be "${io.FORMAT}" (ProjectStore.swift:163)`);
    if (!isInt(manifest.version) || manifest.version < 1 || manifest.version > CURRENT_VERSION) add(`version must be 1 to ${CURRENT_VERSION} (ProjectStore.swift:164)`);
    const v = manifest.version;
    if (manifest.colorSpace !== 'sRGB') add('colorSpace must be "sRGB" (ProjectStore.swift:216)');
    if (typeof manifest.documentID !== 'string' || !UUID.test(manifest.documentID)) add('documentID must be a UUID');
    if (manifest.resolution !== undefined && !(isNumber(manifest.resolution) && manifest.resolution >= 1 && manifest.resolution <= 9600)) add('resolution must be 1 to 9600 (ProjectStore.swift:217)');
    for (const key of ['width', 'height']) {
        if (!isInt(manifest[key]) || manifest[key] < 1 || manifest[key] > MAX_SIDE) add(`${key} must be a whole number 1 to ${MAX_SIDE} (ProjectStore.swift:220)`);
    }
    if (!Array.isArray(manifest.layers)) return [...problems, 'layers must be an array'];
    if (manifest.layers.length > 10000) add('at most 10000 layers (ProjectStore.swift:221)');

    const byID = new Map();
    for (const layer of manifest.layers) {
        const id = String(layer.id || '');
        const label = `layer "${layer.name}"`;
        if (!UUID.test(id)) { add(`${label}: id must be a UUID`); continue; }
        const upper = id.toUpperCase();
        if (byID.has(upper)) add(`${label}: duplicate id ${upper} (ProjectStore.swift:258)`);
        byID.set(upper, layer);
        if (typeof layer.name !== 'string' || !layer.name.trim()) add(`a layer has a blank name (ProjectStore.swift:259)`);
        else if (Buffer.byteLength(layer.name, 'utf8') > 16384) add(`${label}: name longer than 16384 bytes`);
        if (typeof layer.isVisible !== 'boolean') add(`${label}: isVisible must be true or false`);
        const transform = transformProblem(layer.transform, `${label} transform`);
        if (transform) add(transform);
        if (layer.isGroup !== undefined && typeof layer.isGroup !== 'boolean') add(`${label}: isGroup must be true or false`);
        const group = layer.isGroup === true;
        if (layer.imageFile !== undefined) {
            const okPng = layer.imageFile === `${upper}.png`;
            const okExr = v >= 13 && layer.imageFile === `${upper}.exr`;
            if (!okPng && !okExr) add(`${label}: imageFile must be "${upper}.png" (ProjectStore.swift:261)`);
            if (group) add(`${label}: a folder cannot have an imageFile (LayerGroups.swift:34)`);
        }
        if (layer.shape !== undefined) {
            const shape = shapeProblem(layer.shape);
            if (shape) add(`${label}: ${shape}`);
            if (layer.shape.smoothing === true && v < 14) add(`${label}: smooth corners need version 14 (ProjectStore.swift:223)`);
        }
        if (layer.text !== undefined) {
            if (!layer.imageFile) add(`${label}: a text layer needs its imageFile (ProjectStore.swift:231)`);
            if (group || layer.adjustment) add(`${label}: text cannot be on a folder or adjustment layer`);
            if (layer.text.colorRuns && v < 10) add(`${label}: text colorRuns need version 10`);
            if (layer.text.fontRuns && v < 11) add(`${label}: text fontRuns need version 11`);
        }
        if (layer.adjustment !== undefined) {
            if (v < 7) add(`${label}: adjustment layers need version 7 (ProjectStore.swift:234)`);
            if (group || layer.imageFile) add(`${label}: an adjustment layer has no imageFile and is not a folder`);
            if (!ADJUSTMENT_KINDS.includes(layer.adjustment.kind)) add(`${label}: unknown adjustment kind "${layer.adjustment.kind}"`);
            if (['Gaussian Blur', 'Motion Blur', 'Add Noise'].includes(layer.adjustment.kind) && v < 9) add(`${label}: ${layer.adjustment.kind} needs version 9`);
        }
        if (layer.maskFile !== undefined) {
            if (layer.maskFile !== `${upper}.mask.png`) add(`${label}: maskFile must be "${upper}.mask.png" (ProjectStore.swift:241)`);
            if (v < (group ? 6 : 4)) add(`${label}: a mask needs version ${group ? 6 : 4} (ProjectStore.swift:240)`);
        } else {
            if (layer.maskEnabled !== undefined) add(`${label}: maskEnabled needs a maskFile (ProjectStore.swift:242)`);
            if (layer.maskPlacement !== undefined) add(`${label}: maskPlacement needs a maskFile (ProjectStore.swift:243)`);
        }
        if (layer.maskPlacement !== undefined) {
            const placement = transformProblem(layer.maskPlacement, `${label} maskPlacement`);
            if (placement) add(placement);
        }
        const opacity = layer.opacity === undefined ? 1 : layer.opacity;
        const blend = layer.blendMode === undefined ? 'Normal' : layer.blendMode;
        if (!(isNumber(opacity) && opacity >= 0 && opacity <= 1)) add(`${label}: opacity must be 0 to 1 (ProjectStore.swift:248)`);
        if (!BLEND_MODES.includes(blend)) add(`${label}: unknown blend mode "${blend}"`);
        if (v < 3 && (opacity !== 1 || blend !== 'Normal')) add(`${label}: opacity and blend modes need version 3 (ProjectStore.swift:249)`);
        if (group && blend !== 'Normal') add(`${label}: a folder's blend mode must be Normal (ProjectStore.swift:250)`);
        if (group && opacity !== 1 && v < 8) add(`${label}: folder opacity needs version 8 (ProjectStore.swift:250)`);
        if (v === 1 && (layer.parentID !== undefined || group)) add(`${label}: folders need version 2 (ProjectStore.swift:255)`);
        if (v < 5 && layer.maskSourceID !== undefined) add(`${label}: clipping masks need version 5 (ProjectStore.swift:254)`);
    }

    // Folder hierarchy (LayerGroups.swift:30-46): parents exist and are folders, no cycles, at most 64 ancestors.
    for (const layer of manifest.layers) {
        const seen = new Set([String(layer.id).toUpperCase()]);
        let parent = layer.parentID;
        while (parent !== undefined && parent !== null) {
            const id = String(parent).toUpperCase();
            const node = byID.get(id);
            if (seen.size > 64 || seen.has(id) || !node || node.isGroup !== true) {
                add(`layer "${layer.name}": parentID must name a folder, without cycles or more than 64 levels (LayerGroups.swift:38)`);
                break;
            }
            seen.add(id);
            parent = node.parentID;
        }
        if (layer.isGroup === true && seen.size > 64) add(`folder "${layer.name}" is nested too deeply`);
    }

    // Clipping graph (LiveLayerMask.swift:4-19).
    for (const layer of manifest.layers) {
        const path = new Set();
        let current = String(layer.id).toUpperCase();
        while (current) {
            const record = byID.get(current);
            if (path.size >= 256 || path.has(current) || !record) {
                add(`layer "${layer.name}": its clipping chain is broken or circular (LiveLayerMask.swift:9)`);
                break;
            }
            path.add(current);
            if (record.maskSourceID !== undefined) {
                const source = byID.get(String(record.maskSourceID).toUpperCase());
                if (record.isGroup === true || !source || source.isGroup === true || source.adjustment) {
                    add(`layer "${record.name}": a clipping base must be an existing pixel layer, and folders cannot be clipped (LiveLayerMask.swift:13)`);
                    break;
                }
                current = String(record.maskSourceID).toUpperCase();
            } else current = null;
        }
    }

    if (manifest.activeLayerID !== undefined && !byID.has(String(manifest.activeLayerID).toUpperCase())) add('activeLayerID must name a layer (ProjectStore.swift:264)');

    const guides = manifest.guides || [];
    if (!Array.isArray(guides)) add('guides must be an array');
    else if (guides.length) {
        if (v < 8) add('guides need version 8 (ProjectStore.swift:270)');
        if (guides.length > 1000) add('at most 1000 guides');
        const ids = new Set();
        for (const g of guides) {
            if (!UUID.test(String(g.id)) || ids.has(String(g.id).toUpperCase())) add('every guide needs a unique UUID id');
            ids.add(String(g.id).toUpperCase());
            if (g.axis !== 'horizontal' && g.axis !== 'vertical') add('guide axis must be horizontal or vertical');
            if (!(isNumber(g.position) && Math.abs(g.position) <= 1000000)) add('guide position must be within 1000000');
        }
    }

    // Assets (ProjectStore.swift:168-209), when the caller can describe them.
    if (images) {
        let pixels = 0, maskPixels = 0;
        for (const layer of manifest.layers) {
            const label = `layer "${layer.name}"`;
            if (layer.imageFile) {
                const info = images[layer.imageFile];
                if (info === null || info === undefined) add(`${label}: images/${layer.imageFile} is missing`);
                else if (!info.exr) {
                    if (info.animated) add(`${label}: animated PNGs are not accepted`);
                    if (info.bitDepth > 8 && !(info.bitDepth === 16 && v >= 12)) add(`${label}: ${info.bitDepth}-bit images need version 12`);
                    if (info.width > MAX_SIDE || info.height > MAX_SIDE) add(`${label}: image sides must be at most ${MAX_SIDE}`);
                    pixels += info.width * info.height;
                }
            }
            if (layer.maskFile) {
                const info = images[layer.maskFile];
                if (info === null || info === undefined) add(`${label}: images/${layer.maskFile} is missing`);
                else if (info.colorType !== 'gray' || info.bitDepth > 8 || info.transparencyChunk) add(`${label}: a mask must be an 8-bit grayscale PNG without alpha (LayerMask.swift:23)`);
                else {
                    if (info.width > MAX_SIDE || info.height > MAX_SIDE) add(`${label}: mask sides must be at most ${MAX_SIDE}`);
                    maskPixels += info.width * info.height;
                }
            }
        }
        if (pixels > PIXEL_BUDGET) add(`the layers hold ${pixels} pixels; Compositor guarantees at most ${PIXEL_BUDGET}`);
        if (maskPixels > PIXEL_BUDGET) add(`the masks hold ${maskPixels} pixels; Compositor guarantees at most ${PIXEL_BUDGET}`);
    }
    return problems;
}

// The lowest version that allows everything the manifest uses (manifest.md section 9.6).
function minimumVersion(manifest) {
    let v = 1;
    const need = (n) => { v = Math.max(v, n); };
    if ((manifest.guides || []).length) need(8);
    for (const l of manifest.layers || []) {
        if (l.parentID !== undefined || l.isGroup === true) need(2);
        if ((l.opacity !== undefined && l.opacity !== 1) || (l.blendMode && l.blendMode !== 'Normal')) need(3);
        if (l.maskFile) need(l.isGroup ? 6 : 4);
        if (l.maskSourceID !== undefined) need(5);
        if (l.adjustment) need(['Gaussian Blur', 'Motion Blur', 'Add Noise'].includes(l.adjustment.kind) ? 9 : 7);
        if (l.isGroup && l.opacity !== undefined && l.opacity !== 1) need(8);
        if (l.text && l.text.colorRuns) need(10);
        if (l.text && l.text.fontRuns) need(11);
        if (l.imageFile && l.imageFile.endsWith('.exr')) need(13);
        if (l.shape && l.shape.smoothing === true) need(14);
    }
    return v;
}

// Never lower the version a project declares; raise it when new content needs it.
function prepareForWrite(manifest, { diskVersion } = {}) {
    manifest.version = Math.min(CURRENT_VERSION, Math.max(diskVersion || manifest.version || 1, minimumVersion(manifest)));
    for (const l of manifest.layers) {
        l.id = String(l.id).toUpperCase();
        if (typeof l.opacity === 'number') l.opacity = Math.min(1, Math.max(0, l.opacity));
    }
    if (manifest.activeLayerID) manifest.activeLayerID = String(manifest.activeLayerID).toUpperCase();
    return manifest;
}

function kindOf(layer) {
    if (layer.isGroup) return 'folder';
    if (layer.adjustment) return `adjustment (${layer.adjustment.kind})`;
    if (layer.text) return 'text';
    if (layer.shape) return `shape (${layer.shape.kind})`;
    if (!layer.imageFile) return 'blank';
    if (layer.imageFile.endsWith('.exr')) return 'HDR pixels';
    return 'pixels';
}

function readOnlyReason(layer) {
    if (layer.isGroup) return 'it is a folder';
    if (layer.adjustment) return 'it is an adjustment layer';
    if (layer.imageFile && layer.imageFile.endsWith('.exr')) return 'it is an HDR (OpenEXR) layer';
    return null;
}

function describeLayer(layer) {
    const t = layer.transform;
    const out = {
        name: layer.name,
        id: layer.id,
        kind: kindOf(layer),
        visible: layer.isVisible,
        opacity: layer.opacity === undefined ? 1 : layer.opacity,
        blendMode: layer.blendMode || 'Normal',
        x: t.origin[0], y: t.origin[1], width: t.size[0], height: t.size[1],
    };
    if (t.rotation) out.rotation = t.rotation;
    if (t.flipX) out.flipX = true;
    if (t.flipY) out.flipY = true;
    if (layer.parentID) out.inFolder = layer.parentID;
    if (layer.maskFile) out.mask = layer.maskEnabled === false ? 'disabled' : 'enabled';
    if (layer.maskSourceID) out.clippedTo = layer.maskSourceID;
    if (layer.effects) out.effects = Object.keys(layer.effects).filter((k) => layer.effects[k] && layer.effects[k].enabled !== false);
    if (layer.text) out.text = layer.text.content;
    return out;
}

// The project as Claude reads it: layers top first, as the Layers panel lists them.
function describe(manifest) {
    const names = new Map(manifest.layers.map((l) => [l.id, l.name]));
    const layers = manifest.layers.map(describeLayer).reverse();
    for (const l of layers) {
        if (l.inFolder) l.inFolder = names.get(l.inFolder) || l.inFolder;
        if (l.clippedTo) l.clippedTo = names.get(l.clippedTo) || l.clippedTo;
    }
    const active = manifest.layers.find((l) => l.id === manifest.activeLayerID);
    return {
        canvas: { width: manifest.width, height: manifest.height, resolution: manifest.resolution || 72 },
        activeLayer: active ? active.name : null,
        layerOrder: 'top first (the first layer listed is drawn on top), as in the Layers panel',
        layers,
    };
}

function findLayer(manifest, ref) {
    const text = String(ref || '').trim();
    const byID = manifest.layers.find((l) => String(l.id).toUpperCase() === text.toUpperCase());
    if (byID) return byID;
    const named = manifest.layers.filter((l) => l.name === text);
    if (named.length > 1) throw new Error(`Several layers are named "${text}"; use its id (${named.map((l) => l.id).join(', ')}).`);
    return named[0] || null;
}

function transformRecord(x, y, width, height) {
    return { origin: [x, y], size: [width, height], rotation: 0, flipX: false, flipY: false, sampling: 'High quality' };
}

function newPixelLayer({ name, x = 0, y = 0, width, height, opacity = 1, blendMode = 'Normal', visible = true, parentID }) {
    const id = io.newID();
    const layer = {
        id, name, imageFile: `${id}.png`, isVisible: visible, isGroup: false, opacity, blendMode,
        transform: transformRecord(x, y, width, height),
    };
    if (parentID) layer.parentID = parentID;
    return layer;
}

// Directly above `above` in its folder, or at the top of `above` when it is a folder (as Compositor adds layers), or
// on top of the stack. Siblings are ordered by their array positions, so the slot is after the last of them below.
function insertLayer(manifest, layer, { above, top } = {}) {
    const index = above ? manifest.layers.findIndex((l) => l.id === above) : -1;
    if (!top && index >= 0) {
        const anchor = manifest.layers[index];
        let at = index + 1;
        if (anchor.isGroup) {
            layer.parentID = anchor.id;
            manifest.layers.forEach((l, i) => { if (l.parentID === anchor.id) at = Math.max(at, i + 1); });
        } else if (anchor.parentID) layer.parentID = anchor.parentID;
        else delete layer.parentID;
        manifest.layers.splice(at, 0, layer);
    } else {
        delete layer.parentID;
        manifest.layers.push(layer);
    }
}

function editLayer(layer, changes) {
    if (changes.name !== undefined) layer.name = String(changes.name).trim() || layer.name;
    if (changes.visible !== undefined) layer.isVisible = Boolean(changes.visible);
    if (changes.opacity !== undefined) layer.opacity = Math.min(1, Math.max(0, changes.opacity));
    if (changes.blend_mode !== undefined) {
        if (layer.isGroup && changes.blend_mode !== 'Normal') throw new Error('A folder\'s blend mode is always Normal in Compositor.');
        layer.blendMode = changes.blend_mode;
    }
    const t = layer.transform;
    if (changes.x !== undefined) t.origin[0] = changes.x;
    if (changes.y !== undefined) t.origin[1] = changes.y;
    if (changes.width !== undefined) t.size[0] = changes.width;
    if (changes.height !== undefined) t.size[1] = changes.height;
    if (changes.rotation !== undefined) t.rotation = ((changes.rotation % 360) + 360) % 360;
    if (changes.flip_x !== undefined) t.flipX = Boolean(changes.flip_x);
    if (changes.flip_y !== undefined) t.flipY = Boolean(changes.flip_y);
    const geometryChanged = ['width', 'height'].some((k) => changes[k] !== undefined);
    // A resized text layer's PNG no longer matches its text box, so Compositor would stretch it; keep it a picture.
    if (geometryChanged && layer.text) delete layer.text;
}

// Removes a layer (a folder with everything inside it). Layers clipped to a removed layer lose the link, and the new
// active layer is the one that was directly above, as in Compositor (LiveLayerMask.swift:142-145).
function removeLayer(manifest, id) {
    const doomed = new Set([id]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const l of manifest.layers) if (l.parentID && doomed.has(l.parentID) && !doomed.has(l.id)) { doomed.add(l.id); grew = true; }
    }
    const index = manifest.layers.findIndex((l) => l.id === id);
    const removed = manifest.layers.filter((l) => doomed.has(l.id)).map((l) => l.name);
    manifest.layers = manifest.layers.filter((l) => !doomed.has(l.id));
    for (const l of manifest.layers) if (l.maskSourceID && doomed.has(l.maskSourceID)) delete l.maskSourceID;
    if (doomed.has(manifest.activeLayerID) || !manifest.layers.some((l) => l.id === manifest.activeLayerID)) {
        if (manifest.layers.length) manifest.activeLayerID = manifest.layers[Math.min(Math.max(index, 0), manifest.layers.length - 1)].id;
        else delete manifest.activeLayerID;
    }
    return removed;
}

// Reorders a layer among its siblings (same parent), keeping folder contents where they are.
function moveLayer(manifest, id, to, otherID) {
    const layer = manifest.layers.find((l) => l.id === id);
    const siblings = manifest.layers.filter((l) => (l.parentID || null) === (layer.parentID || null));
    const position = siblings.indexOf(layer);
    let target;
    if (to === 'top') target = siblings.length - 1;
    else if (to === 'bottom') target = 0;
    else if (to === 'up') target = Math.min(siblings.length - 1, position + 1);
    else if (to === 'down') target = Math.max(0, position - 1);
    else {
        const other = siblings.find((l) => l.id === otherID);
        if (!other) throw new Error('"other" must be a layer in the same folder.');
        const without = siblings.filter((l) => l !== layer);
        const at = without.indexOf(other) + (to === 'above' ? 1 : 0);
        without.splice(at, 0, layer);
        target = without.indexOf(layer);
    }
    const order = siblings.filter((l) => l !== layer);
    order.splice(target, 0, layer);
    // Write the siblings back into the slots the siblings held, so other folders' records stay put.
    const slots = manifest.layers.map((l, i) => (siblings.includes(l) ? i : -1)).filter((i) => i >= 0);
    slots.forEach((slot, i) => { manifest.layers[slot] = order[i]; });
}

// Painting replaces the pixels, so live text and shape styles no longer describe them (brush.md section 13).
function markPixelsEdited(layer) {
    if (!layer.imageFile) layer.imageFile = `${String(layer.id).toUpperCase()}.png`;
    delete layer.text;
    delete layer.shape;
}

// A new project like Compositor's New Canvas: transparent gives a blank "Layer 1"; a color gives a filled
// "Background" layer. `background` is [r, g, b, a] bytes, or `backgroundPng` ready-made PNG bytes.
function createProject(root, { width, height, resolution = NEW_CANVAS.resolution, background = null, backgroundPng = null }) {
    if (fs.existsSync(root)) throw new Error(`${root} already exists.`);
    const id = io.newID();
    const filled = Boolean(background || backgroundPng);
    const layer = {
        id, name: filled ? 'Background' : 'Layer 1', isVisible: true, isGroup: false, opacity: 1, blendMode: 'Normal',
        transform: transformRecord(0, 0, width, height),
    };
    if (filled) layer.imageFile = `${id}.png`;
    const manifest = {
        format: io.FORMAT, version: CURRENT_VERSION, colorSpace: 'sRGB', documentID: io.newID(),
        width, height, resolution, activeLayerID: id, layers: [layer],
    };
    const problems = validate(manifest);
    if (problems.length) throw new Error(problems[0]);
    fs.mkdirSync(path.join(root, io.IMAGES), { recursive: true });
    const images = filled ? { [layer.imageFile]: backgroundPng || png.solid(width, height, background) } : {};
    io.writeProject(root, manifest, images);
    return manifest;
}

module.exports = {
    CURRENT_VERSION, BLEND_MODES, SAMPLING, SHAPE_KINDS, NEW_CANVAS, MAX_SIDE,
    validate, minimumVersion, prepareForWrite, kindOf, readOnlyReason, describe, describeLayer, findLayer,
    newPixelLayer, insertLayer, editLayer, removeLayer, moveLayer, markPixelsEdited, createProject,
};
