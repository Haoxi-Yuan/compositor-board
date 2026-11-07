'use strict';
// The board's in-memory project: the manifest exactly as read (unknown fields included, so nothing Compositor wrote is
// lost) plus decoded pixels per layer. Tracks what changed since the last save so only those images are encoded,
// merges a newer version from disk with unsaved local edits, and applies history entries.

(function () {
    const CB = (window.CB = window.CB || {});
    const CURRENT_VERSION = 14;

    function pngInfo(bytes) {
        if (!bytes || bytes.length < 33 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return { width: view.getUint32(16), height: view.getUint32(20), bitDepth: bytes[24], colorType: bytes[25] };
    }

    // Layer images are color-managed into sRGB as Core Graphics does; masks keep their raw samples, which the app
    // uses as coverage without any gamma or profile step (compositing.md 6.1, 12.1).
    async function decodeToCanvas(bytes, { raw = false } = {}) {
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), raw
            ? { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }
            : { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'default' });
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close();
        return canvas;
    }

    // DitherPixels.c hash_noise: a fixed pseudo-random value in [0, 1) for each pixel and draw.
    function hashNoise(x, y, draw) {
        let h = (Math.imul(x, 0x9E3779B1) ^ Math.imul(y, 0x85EBCA77) ^ Math.imul(draw, 0xC2B2AE3D)) >>> 0;
        h = (h ^ (h >>> 15)) >>> 0;
        h = Math.imul(h, 0x2C1B3C6D) >>> 0;
        h = (h ^ (h >>> 12)) >>> 0;
        h = Math.imul(h, 0x297A2D39) >>> 0;
        h = (h ^ (h >>> 15)) >>> 0;
        return Math.fround((h >>> 8) / 16777216);
    }
    const lroundf = (v) => Math.sign(v) * Math.floor(Math.abs(v) + 0.5);

    // A 16-bit PNG shown as Compositor shows it: its dithered 8-bit copy (DeepLayer.dithered, DitherPixels.c
    // dither_quantize16), rounded with a fine noise rather than straight down so gradients do not step. Null for a file
    // this reader does not handle (interlaced, palette), which then goes through the browser.
    async function decode16(bytes) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let at = 8, width = 0, height = 0, colorType = -1, interlace = 0;
        const idat = [];
        while (at + 8 <= bytes.length) {
            const length = view.getUint32(at), type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
            const data = bytes.subarray(at + 8, at + 8 + length);
            if (type === 'IHDR') { width = view.getUint32(at + 8); height = view.getUint32(at + 12); colorType = bytes[at + 17]; interlace = bytes[at + 20]; }
            else if (type === 'IDAT') idat.push(data);
            else if (type === 'IEND') break;
            at += 12 + length;
        }
        const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
        if (!channels || interlace || !width || !height) return null;
        const inflated = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
        const bpp = channels * 2, rowBytes = width * bpp;
        if (inflated.length < (rowBytes + 1) * height) return null;
        // Unfilter (PNG filters 0-4) into plain rows.
        const rows = new Uint8Array(rowBytes * height);
        for (let y = 0; y < height; y++) {
            const filter = inflated[y * (rowBytes + 1)], src = y * (rowBytes + 1) + 1, dst = y * rowBytes;
            for (let i = 0; i < rowBytes; i++) {
                const raw = inflated[src + i], left = i >= bpp ? rows[dst + i - bpp] : 0, up = y ? rows[dst - rowBytes + i] : 0;
                const upLeft = y && i >= bpp ? rows[dst - rowBytes + i - bpp] : 0;
                let value;
                if (filter === 0) value = raw;
                else if (filter === 1) value = raw + left;
                else if (filter === 2) value = raw + up;
                else if (filter === 3) value = raw + ((left + up) >> 1);
                else {
                    const pa = Math.abs(up - upLeft), pb = Math.abs(left - upLeft), pc = Math.abs(left + up - 2 * upLeft);
                    value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
                }
                rows[dst + i] = value & 255;
            }
        }
        const image = new ImageData(width, height), out = image.data;
        const k = Math.fround(255 / 65535);
        const sample = (i) => (rows[i] << 8) | rows[i + 1];
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * rowBytes + x * bpp;
                let r, g, b, a;
                if (channels === 1 || channels === 2) { r = g = b = sample(i); a = channels === 2 ? sample(i + 2) : 65535; }
                else { r = sample(i); g = sample(i + 2); b = sample(i + 4); a = channels === 4 ? sample(i + 6) : 65535; }
                // Premultiplied at 16 bits, as the canonical 16-bit context holds it.
                const p = [r, g, b].map((c) => Math.round((c * a) / 65535));
                const alpha = lroundf(Math.fround(a * k));
                const o = (y * width + x) * 4;
                for (let c = 0; c < 3; c++) {
                    const value = Math.fround(Math.fround(Math.fround(Math.fround(p[c] * k) + hashNoise(x, y, c)) + hashNoise(x, y, c + 3)) - 1);
                    const rounded = lroundf(value);
                    const premultiplied = rounded < 0 ? 0 : rounded > alpha ? alpha : rounded;
                    // ImageData is straight alpha.
                    out[o + c] = alpha ? Math.min(255, Math.round((premultiplied * 255) / alpha)) : 0;
                }
                out[o + 3] = alpha;
            }
        }
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext('2d').putImageData(image, 0, 0);
        return canvas;
    }

    // A mask: 8-bit gray coverage (white shows the layer) plus an alpha canvas holding the same values, which the
    // renderer multiplies in with destination-in.
    function maskFromGray(width, height, gray) {
        const alpha = new OffscreenCanvas(width, height);
        const data = new ImageData(width, height);
        for (let i = 0; i < gray.length; i++) data.data[i * 4 + 3] = gray[i];
        alpha.getContext('2d').putImageData(data, 0, 0);
        return { width, height, gray, alpha };
    }

    // The mask as an opaque gray picture (r = g = b = sample, a = 255): what the mask-alone view and thumbnails show and
    // what a mask stroke paints into. Cached on the mask, which never changes once made.
    function grayCanvas(mask) {
        if (mask.grayCanvas) return mask.grayCanvas;
        const canvas = new OffscreenCanvas(mask.width, mask.height);
        const data = new ImageData(mask.width, mask.height);
        for (let i = 0; i < mask.gray.length; i++) {
            const v = mask.gray[i];
            data.data[i * 4] = v; data.data[i * 4 + 1] = v; data.data[i * 4 + 2] = v; data.data[i * 4 + 3] = 255;
        }
        canvas.getContext('2d').putImageData(data, 0, 0);
        mask.grayCanvas = canvas;
        return canvas;
    }

    // A gray picture (any canvas, the red channel read) back to a mask.
    function maskFromCanvas(canvas) {
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        const gray = new Uint8Array(canvas.width * canvas.height);
        for (let i = 0; i < gray.length; i++) gray[i] = pixels[i * 4];
        return maskFromGray(canvas.width, canvas.height, gray);
    }

    async function decodeMask(bytes) {
        const canvas = await decodeToCanvas(bytes, { raw: true });
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        const gray = new Uint8Array(canvas.width * canvas.height);
        for (let i = 0; i < gray.length; i++) gray[i] = pixels[i * 4];
        return maskFromGray(canvas.width, canvas.height, gray);
    }

    // A canvas shown in place of pixels the board cannot decode (OpenEXR): hatched, and never written back.
    function placeholder(width, height) {
        const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgba(128,128,128,0.35)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = Math.max(2, Math.min(canvas.width, canvas.height) / 60);
        for (let x = -canvas.height; x < canvas.width; x += ctx.lineWidth * 6) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x + canvas.height, canvas.height);
            ctx.stroke();
        }
        return canvas;
    }

    async function encodePng(canvas) {
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        return new Uint8Array(await blob.arrayBuffer());
    }

    // An 8-bit grayscale PNG (masks must have no alpha), deflated with the browser's zlib stream.
    const CRC = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c >>> 0;
        }
        return t;
    })();
    function crc32(bytes) {
        let c = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    }
    function chunk(type, data) {
        const out = new Uint8Array(12 + data.length);
        const view = new DataView(out.buffer);
        view.setUint32(0, data.length);
        for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
        out.set(data, 8);
        view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
        return out;
    }
    async function encodeGrayPng(width, height, gray) {
        const raw = new Uint8Array((width + 1) * height);
        for (let y = 0; y < height; y++) raw.set(gray.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
        const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
        const deflated = new Uint8Array(await new Response(stream).arrayBuffer());
        const header = new Uint8Array(13);
        const view = new DataView(header.buffer);
        view.setUint32(0, width);
        view.setUint32(4, height);
        header[8] = 8;
        header[9] = 0;
        const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflated), chunk('IEND', new Uint8Array(0))];
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let offset = 0;
        for (const p of parts) { out.set(p, offset); offset += p.length; }
        return out;
    }

    const clone = (value) => JSON.parse(JSON.stringify(value));

    function kindOf(record) {
        if (record.isGroup) return 'folder';
        if (record.adjustment) return 'adjustment';
        if (record.text) return 'text';
        if (record.shape) return 'shape';
        return 'pixels';
    }

    class BoardDocument {
        constructor() {
            this.manifest = null;
            this.pixels = new Map();
            this.baseHash = null;
            this.dirtyImages = new Set();
            this.dirtyMasks = new Set();
            this.metaDirty = false;
            this.savedIDs = new Set();
            this.pendingExport = null;
            this.problems = [];
        }

        get width() { return this.manifest.width; }
        get height() { return this.manifest.height; }
        get layers() { return this.manifest.layers; }

        layer(id) {
            return this.manifest.layers.find((l) => l.id === id) || null;
        }

        entry(id) {
            let entry = this.pixels.get(id);
            if (!entry) {
                entry = { image: null, mask: null };
                this.pixels.set(id, entry);
            }
            return entry;
        }

        isDirty() {
            return this.metaDirty || this.dirtyImages.size > 0 || this.dirtyMasks.size > 0;
        }

        snapshot() {
            return JSON.stringify(this.manifest);
        }

        // Why a layer's pixels cannot be edited on the board, or null. 16-bit layers paint here (the 8-bit copy previews,
        // compositor-engine commits at 16 bits); HDR ones cannot be decoded or shown, so they stay Compositor's.
        pixelLock(record) {
            if (!record) return 'No layer is selected.';
            if (record.isGroup || record.adjustment) return null;
            const image = this.entry(record.id).image;
            if (image && image.deep && image.deep.startsWith('HDR')) return `This is a ${image.deep} layer. Paint it in Compositor so it keeps its full precision.`;
            return null;
        }

        async decodeInto(record, files) {
            const entry = this.entry(record.id);
            if (record.imageFile && files[record.imageFile]) {
                const bytes = files[record.imageFile];
                if (record.imageFile.toLowerCase().endsWith('.exr')) {
                    const size = (record.transform && record.transform.size) || [this.width, this.height];
                    entry.image = placeholder(Math.round(size[0]), Math.round(size[1]));
                    entry.image.deep = 'HDR (OpenEXR)';
                } else {
                    const info = pngInfo(bytes);
                    const deep = info && info.bitDepth === 16;
                    entry.image = (deep && await decode16(bytes).catch(() => null)) || await decodeToCanvas(bytes);
                    if (deep) entry.image.deep = '16-bit';
                }
                // The file as it was read, kept while these pixels are unchanged: written back verbatim when the layer
                // returns (an undone delete or merge) or is copied, so 16-bit and HDR files survive and 8-bit ones stay
                // byte-exact (layers-masks.md section 23, risk 1).
                entry.image.raw = bytes;
                entry.image.rawExtension = record.imageFile.slice(record.imageFile.lastIndexOf('.'));
            } else if (!record.imageFile) {
                entry.image = null;
            }
            if (record.maskFile && files[record.maskFile]) entry.mask = await decodeMask(files[record.maskFile]);
            else if (!record.maskFile) entry.mask = null;
        }

        async load({ manifest, manifestHash, images }) {
            this.manifest = clone(manifest);
            this.pixels = new Map();
            this.problems = [];
            for (const record of this.manifest.layers || []) {
                try {
                    await this.decodeInto(record, images);
                } catch (error) {
                    this.problems.push(`${record.name}: ${error.message}`);
                }
            }
            this.baseHash = manifestHash;
            this.dirtyImages.clear();
            this.dirtyMasks.clear();
            this.metaDirty = false;
            this.pendingExport = null;
            this.savedIDs = new Set(this.manifest.layers.map((l) => l.id));
            this.lastSavedMeta = this.snapshot();
        }

        // A save request: the manifest and the images changed since the last save. Dirty marks move to
        // `pendingExport` until the extension confirms the write, and come back if it does not.
        async exportChanges() {
            this.restorePending();
            if (!this.isDirty()) return { changed: false };
            const pending = { images: new Set(this.dirtyImages), masks: new Set(this.dirtyMasks), meta: this.metaDirty };
            this.dirtyImages.clear();
            this.dirtyMasks.clear();
            this.metaDirty = false;
            pending.snapshot = this.snapshot();
            this.pendingExport = pending;
            // The extension sets the version the content needs (core/manifest.js prepareForWrite).
            const manifest = clone(this.manifest);
            const images = {};
            for (const record of manifest.layers) {
                const entry = this.entry(record.id);
                if (pending.images.has(record.id) && entry.image) {
                    if (entry.image.raw) {
                        // Unchanged since it was read: the original file, under this layer's name.
                        record.imageFile = `${record.id}${entry.image.rawExtension || '.png'}`;
                        images[record.imageFile] = entry.image.raw;
                    } else if (!entry.image.deep) {
                        record.imageFile = `${record.id}.png`;
                        images[record.imageFile] = await encodePng(entry.image);
                    }
                }
                if (pending.masks.has(record.id) && entry.mask) {
                    record.maskFile = `${record.id}.mask.png`;
                    images[record.maskFile] = await encodeGrayPng(entry.mask.width, entry.mask.height, entry.mask.gray);
                }
            }
            return { changed: true, manifest, images, baseHash: this.baseHash };
        }

        restorePending() {
            if (!this.pendingExport) return;
            for (const id of this.pendingExport.images) this.dirtyImages.add(id);
            for (const id of this.pendingExport.masks) this.dirtyMasks.add(id);
            if (this.pendingExport.meta) this.metaDirty = true;
            this.pendingExport = null;
        }

        markSaved(manifestHash) {
            this.baseHash = manifestHash;
            if (this.pendingExport) this.lastSavedMeta = this.pendingExport.snapshot;
            this.pendingExport = null;
            this.savedIDs = new Set(this.manifest.layers.map((l) => l.id));
        }

        // A newer version from disk (written by Claude or by Compositor). Without unsaved local edits it is taken as
        // it is; with them, local edits win for the layers they touched and everything else comes from disk. Returns
        // the history entry describing the change (or null if nothing changed) and whether a save is still needed.
        async mergeExternal({ manifest: disk, manifestHash, images, label }) {
            this.restorePending();
            const metaBefore = this.snapshot();
            const localDirty = this.isDirty();
            const touched = new Set([...this.dirtyImages, ...this.dirtyMasks]);
            let merged = clone(disk);
            if (localDirty) {
                const current = this.manifest.layers;
                const currentIDs = new Set(current.map((l) => l.id));
                const diskIDs = new Set(merged.layers.map((l) => l.id));
                const keepLocal = new Set(touched);
                if (this.metaDirty) {
                    // Records edited locally since the last save (renamed, moved, restyled) keep their local form.
                    const saved = new Map((JSON.parse(this.lastSavedMeta || 'null') || { layers: [] }).layers.map((l) => [l.id, JSON.stringify(l)]));
                    for (const l of current) if (saved.get(l.id) !== JSON.stringify(l)) keepLocal.add(l.id);
                }
                for (const id of keepLocal) {
                    const local = current.find((l) => l.id === id);
                    if (!local) continue;
                    const index = merged.layers.findIndex((l) => l.id === id);
                    if (index >= 0) merged.layers[index] = clone(local);
                    else {
                        const below = current[current.indexOf(local) - 1];
                        const at = below ? merged.layers.findIndex((l) => l.id === below.id) + 1 : 0;
                        merged.layers.splice(at > 0 ? at : merged.layers.length, 0, clone(local));
                    }
                }
                for (const id of this.savedIDs) if (!currentIDs.has(id) && diskIDs.has(id)) merged.layers = merged.layers.filter((l) => l.id !== id);
                if (currentIDs.has(this.manifest.activeLayerID)) merged.activeLayerID = this.manifest.activeLayerID;
            }

            const pixels = [];
            for (const record of merged.layers) {
                if (touched.has(record.id)) continue;
                const entry = this.entry(record.id);
                const imageChanged = record.imageFile ? Boolean(images[record.imageFile]) : Boolean(entry.image);
                const maskChanged = record.maskFile ? Boolean(images[record.maskFile]) : Boolean(entry.mask);
                if (!imageChanged && !maskChanged) continue;
                const before = { image: entry.image, mask: entry.mask };
                const fresh = { image: entry.image, mask: entry.mask };
                await this.decodeInto(record, images);
                if (imageChanged) {
                    fresh.image = entry.image;
                    pixels.push({ layerID: record.id, kind: 'image', beforeBitmap: before.image, afterBitmap: fresh.image });
                }
                if (maskChanged) {
                    fresh.mask = entry.mask;
                    pixels.push({ layerID: record.id, kind: 'mask', beforeMask: before.mask, afterMask: fresh.mask });
                }
            }
            this.manifest = merged;
            this.baseHash = manifestHash;
            if (!localDirty) {
                this.savedIDs = new Set(merged.layers.map((l) => l.id));
                this.lastSavedMeta = JSON.stringify(disk);
            } else {
                this.metaDirty = true;
            }
            const metaAfter = this.snapshot();
            if (metaAfter === metaBefore && !pixels.length) return { entry: null, dirty: this.isDirty() };
            return { entry: { label: label || 'Change from outside', metaBefore, metaAfter, pixels }, dirty: this.isDirty() };
        }

        // Undo, redo and first application of a history entry share this.
        apply(entry, which) {
            const meta = which === 'before' ? entry.metaBefore : entry.metaAfter;
            if (meta) {
                const present = new Set(this.manifest.layers.map((l) => l.id));
                this.manifest = JSON.parse(meta);
                this.metaDirty = true;
                // Layers coming back (an undone delete) lost their files on disk when the deletion was saved.
                for (const l of this.manifest.layers) {
                    if (present.has(l.id)) continue;
                    const entry = this.entry(l.id);
                    if (entry.image && l.imageFile) this.dirtyImages.add(l.id);
                    if (entry.mask && l.maskFile) this.dirtyMasks.add(l.id);
                }
            }
            for (const p of entry.pixels || []) {
                const target = this.entry(p.layerID);
                if (p.rect) {
                    delete target.image.raw;
                    const ctx = target.image.getContext('2d');
                    ctx.clearRect(p.rect.x, p.rect.y, p.rect.width, p.rect.height);
                    ctx.drawImage(which === 'before' ? p.before : p.after, p.rect.x, p.rect.y);
                    this.dirtyImages.add(p.layerID);
                } else if (p.kind === 'mask') {
                    target.mask = which === 'before' ? p.beforeMask : p.afterMask;
                    this.dirtyMasks.add(p.layerID);
                } else {
                    target.image = which === 'before' ? p.beforeBitmap : p.afterBitmap;
                    this.dirtyImages.add(p.layerID);
                }
            }
        }
    }

    CB.Document = { BoardDocument, CURRENT_VERSION, kindOf, pngInfo, decodeToCanvas, decodeMask, maskFromGray, maskFromCanvas, grayCanvas, encodePng, encodeGrayPng, clone };
})();
