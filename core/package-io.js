'use strict';
// Reading and writing Compositor `.comp` packages on disk, shared by the VS Code extension and the MCP server.
// Only Node built-ins, so the extension ships without node_modules.
//
// Write order follows upstream docs/writing-comp-files.md: images first (each via a temporary file renamed into
// place), then the manifest the same way, so an open Compositor window only ever sees a complete project. The
// app's own save replaces the whole package directory, so nothing we keep may live inside it apart from
// manifest.json, images/ and QuickLook/.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const noteTargets = require('./note-target');

const FORMAT = 'com.compositor.project';
const MANIFEST = 'manifest.json';
const IMAGES = 'images';
const LOCK_STALE_MS = 10000;

function newID() {
    return crypto.randomUUID().toUpperCase();
}

function hash(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

// A package path from anything that points into it: the folder itself, its manifest.json or an image.
function packageRoot(target) {
    let current = path.resolve(target);
    while (current !== path.dirname(current)) {
        if (current.toLowerCase().endsWith('.comp')) return current;
        current = path.dirname(current);
    }
    throw new Error(`Not inside a .comp package: ${target}`);
}

// Notes between the person and Claude sit beside the package, since Compositor's save would drop them inside it.
function notesPath(root) {
    return root + '.notes.json';
}

function lockPath(root) {
    return root + '.lock';
}

// Board-only layer state beside the package, like the notes: the ids of the layers locked on the board, and the Pen's
// paths by layer id (each a list of versions, latest last). Compositor has neither, so this is the board's own (and
// Compositor's save would drop anything it does not know).
function boardStatePath(root) {
    return root + '.board.json';
}

function readManifestBytes(root) {
    return fs.readFileSync(path.join(root, MANIFEST));
}

function readProject(root) {
    const bytes = readManifestBytes(root);
    let manifest;
    try {
        manifest = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        throw new Error(`manifest.json is not valid JSON: ${error.message}`);
    }
    return { root, manifest, manifestHash: hash(bytes) };
}

function imagePath(root, filename) {
    if (!filename || filename !== path.basename(filename) || filename.startsWith('.')) {
        throw new Error(`Unsafe image filename: ${filename}`);
    }
    return path.join(root, IMAGES, filename);
}

function readImage(root, filename) {
    return fs.readFileSync(imagePath(root, filename));
}

// Name and byte size of every file in images/, which is what Compositor's change detection compares.
function imageStats(root) {
    const dir = path.join(root, IMAGES);
    const stats = {};
    if (!fs.existsSync(dir)) return stats;
    for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('.')) continue;
        const stat = fs.statSync(path.join(dir, name));
        if (stat.isFile()) stats[name] = { size: stat.size, mtimeMs: stat.mtimeMs };
    }
    return stats;
}

function writeAtomic(target, bytes) {
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(temp, bytes);
    fs.renameSync(temp, target);
}

function referencedFiles(manifest) {
    const files = new Set();
    for (const layer of manifest.layers || []) {
        if (layer.imageFile) files.add(layer.imageFile);
        if (layer.maskFile) files.add(layer.maskFile);
    }
    return files;
}

// Serializes writers from different processes (the extension and the MCP server) with a lock file beside the
// package. A lock older than LOCK_STALE_MS is taken over, so a crashed writer never blocks the project.
function withLock(root, body) {
    const lock = lockPath(root);
    const deadline = Date.now() + LOCK_STALE_MS;
    for (;;) {
        try {
            fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
            break;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            let age = 0;
            try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
            if (age > LOCK_STALE_MS || Date.now() > deadline) {
                try { fs.unlinkSync(lock); } catch { /* another writer removed it first */ }
                continue;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
    }
    try {
        return body();
    } finally {
        try { fs.unlinkSync(lock); } catch { /* already gone */ }
    }
}

// Writes `images` ({filename: Buffer}) and then `manifest`, removes images the manifest no longer references and the
// stale QuickLook preview. With `expectHash`, refuses to write if the manifest on disk changed since it was read, so
// the caller can merge with the newer version instead of overwriting it.
function writeProject(root, manifest, images = {}, { expectHash } = {}) {
    return withLock(root, () => {
        if (expectHash && fs.existsSync(path.join(root, MANIFEST))) {
            const current = hash(readManifestBytes(root));
            if (current !== expectHash) {
                const error = new Error('The project changed on disk since it was read.');
                error.code = 'ECONFLICT';
                throw error;
            }
        }
        fs.mkdirSync(path.join(root, IMAGES), { recursive: true });
        for (const [filename, bytes] of Object.entries(images)) {
            const target = imagePath(root, filename);
            writeAtomic(target, distinctSize(bytes, target));
        }
        const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        writeAtomic(path.join(root, MANIFEST), bytes);
        const keep = referencedFiles(manifest);
        for (const name of fs.readdirSync(path.join(root, IMAGES))) {
            if (!name.startsWith('.') && !keep.has(name)) fs.rmSync(path.join(root, IMAGES, name), { force: true });
        }
        fs.rmSync(path.join(root, 'QuickLook'), { recursive: true, force: true });
        return { manifestHash: hash(bytes) };
    });
}

// Compositor notices a changed image by its name and byte size only. New pixels that happen to encode to the same
// size as the file they replace get a small tEXt chunk, which decoders ignore, so the app still reloads them.
function distinctSize(bytes, target) {
    let existing;
    try { existing = fs.readFileSync(target); } catch { return bytes; }
    if (existing.length !== bytes.length || existing.equals(bytes) || !pngInfo(bytes)) return bytes;
    const { crc32 } = require('./png');
    const body = Buffer.concat([Buffer.from('tEXt', 'latin1'), Buffer.from(`Comment\0compositor-board ${Date.now()}`, 'latin1')]);
    const chunk = Buffer.alloc(body.length + 8);
    chunk.writeUInt32BE(body.length - 4, 0);
    body.copy(chunk, 4);
    chunk.writeUInt32BE(crc32(body), body.length + 4);
    // Just before IEND, the last 12 bytes of every PNG.
    return Buffer.concat([bytes.subarray(0, bytes.length - 12), chunk, bytes.subarray(bytes.length - 12)]);
}

function readNotes(root) {
    try {
        const data = JSON.parse(fs.readFileSync(notesPath(root), 'utf8'));
        return Array.isArray(data.notes) ? data.notes : [];
    } catch {
        return [];
    }
}

function writeNotes(root, notes) {
    writeAtomic(notesPath(root), JSON.stringify({ format: 'compositor-board.notes', version: 1, notes }, null, 2) + '\n');
}

function readBoardState(root) {
    try {
        const data = JSON.parse(fs.readFileSync(boardStatePath(root), 'utf8'));
        const map = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
        return {
            locked: Array.isArray(data.locked) ? data.locked.filter((id) => typeof id === 'string') : [],
            paths: Object.fromEntries(Object.entries(map(data.paths)).filter(([, versions]) => Array.isArray(versions))),
            shapes: Object.fromEntries(Object.entries(map(data.shapes)).filter(([, style]) => isShapeStyle(style))),
            noteTarget: noteTargets.normalize(data.noteTarget),
        };
    } catch {
        return { locked: [], paths: {}, shapes: {}, noteTarget: null };
    }
}

// An outlined shape's style (the board's Shape tool): what media/shapes.js draws it from.
function isShapeStyle(style) {
    return Boolean(style && typeof style === 'object' && typeof style.kind === 'string' && typeof style.paint === 'string'
        && Number.isFinite(style.strokeWidth) && Array.isArray(style.stroke));
}

// Nothing locked, no paths, no outlined shapes and no notes' edit target leave no file behind.
function writeBoardState(root, state) {
    const locked = [...new Set(state.locked || [])].filter((id) => typeof id === 'string');
    const paths = Object.fromEntries(Object.entries(state.paths || {}).filter(([, versions]) => Array.isArray(versions) && versions.length));
    const shapes = Object.fromEntries(Object.entries(state.shapes || {}).filter(([, style]) => isShapeStyle(style)));
    const noteTarget = noteTargets.normalize(state.noteTarget);
    if (!locked.length && !Object.keys(paths).length && !Object.keys(shapes).length && !noteTarget) {
        fs.rmSync(boardStatePath(root), { force: true });
        return;
    }
    writeAtomic(boardStatePath(root), JSON.stringify({ format: 'compositor-board.board', version: 1, locked, paths, shapes, noteTarget }) + '\n');
}

// Width, height, bit depth and color type from a PNG's IHDR chunk, and whether it has transparency (tRNS) or
// animation (acTL) chunks, without decoding it.
function pngInfo(bytes) {
    bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const signature = '89504e470d0a1a0a';
    if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== signature || bytes.toString('latin1', 12, 16) !== 'IHDR') {
        return null;
    }
    const colorTypes = { 0: 'gray', 2: 'rgb', 3: 'palette', 4: 'gray-alpha', 6: 'rgba' };
    const info = {
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
        bitDepth: bytes[24],
        colorType: colorTypes[bytes[25]] || `unknown-${bytes[25]}`,
        transparencyChunk: false,
        animated: false,
    };
    for (let offset = 8; offset + 8 <= bytes.length;) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('latin1', offset + 4, offset + 8);
        if (type === 'tRNS') info.transparencyChunk = true;
        if (type === 'acTL') info.animated = true;
        if (type === 'IDAT' || type === 'IEND') break;
        offset += 12 + length;
    }
    return info;
}

module.exports = {
    FORMAT, MANIFEST, IMAGES,
    newID, hash, packageRoot, notesPath, lockPath, boardStatePath,
    readManifestBytes, readProject, imagePath, readImage, imageStats, referencedFiles,
    writeAtomic, withLock, writeProject, readNotes, writeNotes, readBoardState, writeBoardState, pngInfo,
};
