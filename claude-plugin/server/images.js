'use strict';
// Image work for the MCP tools, with sharp: preparing what Claude looks at (scaled to a size vision handles well,
// transparency shown as a checkerboard) and turning what Claude draws (SVG or PNG) into layer pixels Compositor
// accepts (8-bit RGBA PNG).

const fs = require('fs');
const sharp = require('sharp');

const VIEW_MAX = 1568;

function checkerSvg(width, height, cell = 12) {
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<defs><pattern id="c" width="${cell * 2}" height="${cell * 2}" patternUnits="userSpaceOnUse">
<rect width="${cell * 2}" height="${cell * 2}" fill="#ffffff"/><rect width="${cell}" height="${cell}" fill="#d9d9d9"/>
<rect x="${cell}" y="${cell}" width="${cell}" height="${cell}" fill="#d9d9d9"/></pattern></defs>
<rect width="100%" height="100%" fill="url(#c)"/></svg>`);
}

// Flattens an image with transparency over a checkerboard (or a solid color) so its alpha is visible.
async function flatten(png, background = 'checker') {
    if (background === 'transparent') return png;
    const { width, height } = await sharp(png).metadata();
    if (background === 'checker') {
        return sharp(checkerSvg(width, height)).composite([{ input: png }]).png().toBuffer();
    }
    return sharp(png).flatten({ background }).png().toBuffer();
}

// Crops to `region` ({x, y, width, height} in the image's pixels, clamped) and scales down so the long side is at
// most `maxSize`. Returns the PNG plus the scale from returned pixels back to source pixels.
async function prepareView(input, { region, maxSize = VIEW_MAX, format = 'png' } = {}) {
    let image = sharp(input);
    const meta = await image.metadata();
    let left = 0, top = 0, width = meta.width, height = meta.height;
    if (region) {
        left = clamp(Math.floor(region.x), 0, meta.width - 1);
        top = clamp(Math.floor(region.y), 0, meta.height - 1);
        width = clamp(Math.ceil(region.width), 1, meta.width - left);
        height = clamp(Math.ceil(region.height), 1, meta.height - top);
        image = image.extract({ left, top, width, height });
    }
    const limit = Math.min(maxSize || VIEW_MAX, 2576);
    const scale = Math.min(1, limit / Math.max(width, height));
    if (scale < 1) image = sharp(await image.toBuffer()).resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), { kernel: 'lanczos3' });
    const data = format === 'jpeg' ? await image.jpeg({ quality: 88 }).toBuffer() : await image.png().toBuffer();
    return {
        data,
        mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
        width: Math.round(width * scale),
        height: Math.round(height * scale),
        region: { x: left, y: top, width, height },
        scale,
    };
}

function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
}

// Re-encodes whatever sharp pipeline `image` holds as an 8-bit sRGB RGBA PNG, the only layer format Compositor's
// docs promise to load.
async function rgba8(image) {
    const { data, info } = await image.toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
    return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png({ compressionLevel: 6 }).toBuffer();
}

// An SVG rendered at exactly width x height pixels.
async function rasterizeSvg(svg, width, height) {
    const source = String(svg).trim();
    if (!/^<svg[\s>]/i.test(source) && !/^<\?xml/i.test(source)) throw new Error('svg must be a complete <svg> document.');
    return rgba8(sharp(Buffer.from(source), { density: 72 }).resize(width, height, { fit: 'fill' }));
}

// Any image (a file path or base64 data), optionally resized to width x height.
async function normalizePng({ path: file, base64 }, width, height) {
    const input = file ? fs.readFileSync(file) : Buffer.from(String(base64).replace(/^data:[^,]+,/, ''), 'base64');
    let image = sharp(input).rotate();
    if (width && height) image = image.resize(width, height, { fit: 'fill' });
    return rgba8(image);
}

async function size(input) {
    const meta = await sharp(input).metadata();
    return { width: meta.width, height: meta.height };
}

// Draws `top` (PNG, same size) over `bottom` (PNG), keeping the result 8-bit RGBA.
async function over(bottom, top) {
    return rgba8(sharp(await sharp(bottom).ensureAlpha().composite([{ input: top, blend: 'over' }]).png().toBuffer()));
}

async function blank(width, height) {
    return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
}

module.exports = { VIEW_MAX, flatten, prepareView, rasterizeSvg, normalizePng, size, over, blank };
