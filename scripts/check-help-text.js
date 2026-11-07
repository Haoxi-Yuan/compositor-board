#!/usr/bin/env node
// Lists the "Help text" lines of docs/parity/features.md whose quoted strings all occur in the board's code
// (vscode-extension/media/*.js and extension.js), and the ones that do not yet (docs/port-specs/chrome.md 19.4).
// A string found is not by itself proof the line is done: check it in context before ticking.
//
//   node scripts/check-help-text.js [--missing] [--unticked]

'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const features = fs.readFileSync(path.join(root, 'docs/parity/features.md'), 'utf8').split('\n');
const sources = [path.join(root, 'vscode-extension/extension.js')];
const media = path.join(root, 'vscode-extension/media');
for (const file of fs.readdirSync(media)) if (file.endsWith('.js')) sources.push(path.join(media, file));
// JS escapes for the characters Compositor writes literally.
const code = sources.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\'/g, '\'').replace(/\\"/g, '"');

const missingOnly = process.argv.includes('--missing');
const untickedOnly = process.argv.includes('--unticked');
let found = 0, missing = 0;
features.forEach((line, index) => {
    if (!line.includes('Status bar and hints › Help text ›')) return;
    const ticked = line.startsWith('- [x]');
    if (untickedOnly && ticked) return;
    // The quoted strings after the line's label; interpolations like \(name) match any text.
    const body = line.slice(line.indexOf('›', line.indexOf('Help text ›') + 11) + 1);
    const quoted = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).filter((q) => q.trim());
    if (!quoted.length) return;
    const parts = quoted.flatMap((q) => q.split(/\\\([^)]*\)/).map((p) => p.trim()).filter((p) => p.length > 2));
    const ok = parts.length > 0 && parts.every((p) => code.includes(p));
    if (ok) found++; else missing++;
    if (missingOnly ? !ok : ok) console.log(`${index + 1}${ticked ? ' [x]' : ''}\t${quoted.join(' | ').slice(0, 140)}`);
});
console.error(`${found} lines with every string present, ${missing} with some missing`);
