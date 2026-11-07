#!/usr/bin/env node
'use strict';
// MCP server for the Compositor Board plugin: lets Claude look at and draw on a Compositor `.comp` project while
// the person draws on the same project in the Compositor Board VS Code extension or in the Compositor app.
//
// Where Claude's view of the canvas comes from, best first:
//   vscode       the open VS Code board's live canvas, strokes not yet on disk included (local bridge)
//   window       a screenshot of the Compositor app's window, when the app has the project open (Screen Recording)
//   engine       Compositor's own renderer (compositor-engine) on the project as saved: exact, no permission needed
//   app-save     ⌘S in Compositor, then its own flattened preview (Accessibility permission)
//   saved        the preview Compositor wrote at its last save, if nothing changed since
// Writes always go to disk with the same atomic order the app's docs require; an open board or Compositor window
// reloads them within half a second.

const fs = require('fs');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const io = require('./core/package-io');
const noteTargets = require('./core/note-target');
const manifests = require('./core/manifest');
const bridge = require('./core/bridge-protocol');
const app = require('./compositor-app');
const images = require('./images');
const { EngineClient } = require('./core/engine-client');

const engine = new EngineClient(path.join(__dirname, 'bin', 'compositor-engine'));
process.on('exit', () => engine.stop());

// The Claude Code session that started this server (its parent process), recorded so a board's "Send to Claude"
// can reach it. `roots` are the projects this session's tools touched, latest first: a board picks the session that
// last worked on it.
const session = {
    pid: process.pid, sessionPid: process.ppid, cwd: process.cwd(), socket: process.env.CLAUDE_CODE_MESSAGING_SOCKET || null,
    startedAt: Date.now(), usedAt: 0, roots: [],
};
function recordSession() {
    try { bridge.writeSession(session); } catch { /* the board just cannot pick this session */ }
}
recordSession();
process.on('exit', () => bridge.removeSession(process.pid));
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => process.exit(0));

const server = new McpServer({ name: 'compositor-board', version: '0.1.0' });

const projectPath = z.string().describe('Path to the .comp project folder (or any file inside it).');
const layerRef = z.string().describe('Layer id (UUID) or exact layer name.');
const regionSchema = z.object({
    x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(),
}).describe('Rectangle in document pixels (origin top-left).');

function text(value) {
    return { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) };
}

function image(view) {
    return { type: 'image', data: view.data.toString('base64'), mimeType: view.mimeType };
}

function fail(error) {
    return { isError: true, content: [text(error.message || String(error))] };
}

function tool(name, config, handler) {
    server.registerTool(name, config, async (args) => {
        try {
            return await handler(args);
        } catch (error) {
            return fail(error);
        }
    });
}

function resolveRoot(target) {
    const root = io.packageRoot(path.resolve(String(target).replace(/^~(?=$|\/)/, process.env.HOME)));
    if (!fs.existsSync(path.join(root, io.MANIFEST))) throw new Error(`No manifest.json in ${root}`);
    session.usedAt = Date.now();
    session.roots = [root, ...session.roots.filter((r) => r !== root)].slice(0, 20);
    recordSession();
    return root;
}

// Before reading files or writing over them, unsaved strokes in an open VS Code board are written out, so Claude
// never works from, or overwrites, a version older than what the person sees.
async function flushBoard(root) {
    const host = await bridge.hostFor(root);
    if (!host) return false;
    const answer = await bridge.request(host, 'POST', '/v1/flush', { root });
    return Boolean(answer && answer.saved);
}

// Applies `change(manifest, project)` to the project on disk and writes the result, retrying if someone else wrote
// in between. `change` returns { images: {filename: Buffer}, summary }.
async function updateProject(root, change) {
    await flushBoard(root);
    for (let attempt = 0; attempt < 4; attempt++) {
        const project = io.readProject(root);
        const manifest = JSON.parse(JSON.stringify(project.manifest));
        const result = await change(manifest, project);
        manifests.prepareForWrite(manifest);
        const problems = manifests.validate(manifest, { images: describeImages(root, manifest, result.images || {}) });
        if (problems.length) throw new Error(`Compositor would refuse this change: ${problems.join('; ')}`);
        try {
            io.writeProject(root, manifest, result.images || {}, { expectHash: project.manifestHash });
            return result.summary;
        } catch (error) {
            if (error.code !== 'ECONFLICT') throw error;
        }
    }
    throw new Error('The project kept changing while writing; try again.');
}

function describeImages(root, manifest, pending) {
    const info = {};
    for (const file of io.referencedFiles(manifest)) {
        try {
            if (file.endsWith('.exr')) info[file] = { exr: true };
            else info[file] = io.pngInfo(pending[file] || io.readImage(root, file));
        } catch {
            info[file] = null;
        }
    }
    return info;
}

function findLayer(manifest, ref) {
    const layer = manifests.findLayer(manifest, ref);
    if (!layer) throw new Error(`No layer "${ref}". Layers: ${(manifest.layers || []).map((l) => `${l.name} (${l.id})`).join(', ')}`);
    return layer;
}

async function boardStatus(root) {
    const boards = await bridge.listBoards().catch(() => []);
    const board = boards.find((b) => path.resolve(b.root) === root);
    let live = null;
    if (board) {
        // What the person has going on the board right now: the tool, the active layer and their selection.
        const host = await bridge.hostFor(root).catch(() => null);
        live = host ? await bridge.request(host, 'POST', '/v1/state', { root }).catch(() => null) : null;
    }
    return {
        vscode: board ? {
            open: true, unsavedStrokes: board.dirty, visible: board.visible,
            tool: live ? live.tool : undefined, activeLayer: live ? live.activeLayer : undefined,
            selection: live ? live.selection || 'none' : undefined,
        } : { open: false },
        compositorApp: { running: await app.isRunning(), hasThisProjectOpen: await app.hasProjectOpen(root) },
    };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

tool('list_boards', {
    title: 'List open boards',
    description: 'Lists Compositor projects open as boards in VS Code (any window) and whether the Compositor app is running. Use it first to find the project the person is working on.',
    inputSchema: {},
}, async () => {
    const boards = await bridge.listBoards().catch(() => []);
    const running = await app.isRunning();
    return {
        content: [text({
            vscodeBoards: boards.map((b) => ({ path: b.root, name: b.name, place: b.place === 'sidebar' ? 'side bar' : 'editor tab', unsavedStrokes: b.dirty, visible: b.visible, focused: b.active })),
            compositorApp: running ? 'running' : 'not running',
            note: boards.length ? undefined : 'No board is open in VS Code (or the Compositor Board extension is not installed/enabled).',
        })],
    };
});

tool('read_board', {
    title: 'Read board structure',
    description: 'Describes a .comp project: canvas size, every layer (id, name, position/size in document pixels, visibility, opacity, blend mode, mask/clipping/group/adjustment/effects/text/shape flags) from bottom to top, the notes the person (or Claude) pinned on the canvas, and where the board is open. Each of the person\'s notes carries an editTarget saying where its change goes: usually files in their workspace, not the board. Unsaved strokes in an open VS Code board are saved first.',
    inputSchema: { path: projectPath },
}, async ({ path: target }) => {
    const root = resolveRoot(target);
    await flushBoard(root);
    const { manifest } = io.readProject(root);
    // The person's notes say where their change goes (core/note-target.js): their own target, the board's, or the
    // workspace.
    const boardTarget = io.readBoardState(root).noteTarget;
    const notes = io.readNotes(root).map((note) => {
        if (note.author === 'claude' || note.replyTo) return note;
        const target = noteTargets.effective(root, note, boardTarget);
        return { ...note, editTarget: { ...target, guidance: noteTargets.guidance(target) } };
    });
    return {
        content: [text({
            project: root,
            ...manifests.describe(manifest),
            notes,
            openIn: await boardStatus(root),
        })],
    };
});

async function viewFromVscode(root, args) {
    const host = await bridge.hostFor(root);
    if (!host) return null;
    const answer = await bridge.request(host, 'POST', '/v1/capture', {
        root, maxSize: args.max_size || images.VIEW_MAX, region: args.region, showNotes: args.show_notes !== false, showSelection: args.show_selection !== false,
    }, { timeout: 30000 });
    if (!answer) return null;
    return {
        view: { data: Buffer.from(answer.png, 'base64'), mimeType: 'image/png' },
        about: {
            source: 'vscode',
            freshness: 'live: exactly what the VS Code board shows now, including strokes not yet saved',
            imageSize: [answer.width, answer.height],
            documentRegion: answer.region,
            documentPixelsPerImagePixel: answer.scale ? Number((1 / answer.scale).toFixed(4)) : undefined,
            notRendered: answer.notRendered && answer.notRendered.length ? answer.notRendered : undefined,
            personSelection: answer.selection || undefined,
        },
    };
}

async function viewFromWindow(root, args) {
    const capture = await app.captureWindow(root);
    const view = await images.prepareView(capture.png, { maxSize: args.max_size });
    return {
        view,
        about: {
            source: 'window',
            freshness: 'live: a screenshot of the Compositor app window, interface included, at its current zoom',
            windowMatchedProject: capture.matchedTitle ? true : 'unknown (window titles need Screen Recording; the frontmost Compositor window was used)',
            imageSize: [view.width, view.height],
        },
    };
}

async function viewFromEngine(root, args) {
    await flushBoard(root);
    const out = engine.tempFile('png');
    const result = await engine.request('render', { project: root, out });
    try {
        const flat = await images.flatten(fs.readFileSync(out), 'checker');
        const view = await images.prepareView(flat, { region: args.region, maxSize: args.max_size });
        return {
            view,
            about: {
                source: 'engine',
                freshness: 'the project as saved on disk, rendered by Compositor\'s own code (adjustment layers and effects included)',
                imageSize: [view.width, view.height],
                documentRegion: view.region,
                documentPixelsPerImagePixel: Number((1 / view.scale).toFixed(4)),
                documentSize: [result.documentWidth, result.documentHeight],
            },
        };
    } finally {
        fs.rmSync(out, { force: true });
    }
}

async function viewFromPreview(root, args, jpg, source, freshness) {
    const { manifest } = io.readProject(root);
    const full = await images.size(jpg);
    const factor = full.width / manifest.width;
    const region = args.region && { x: args.region.x * factor, y: args.region.y * factor, width: args.region.width * factor, height: args.region.height * factor };
    const view = await images.prepareView(jpg, { region, maxSize: args.max_size, format: 'jpeg' });
    return {
        view,
        about: {
            source, freshness,
            note: 'Compositor\'s own render, flattened on white, at most 1024 px on the long side.',
            imageSize: [view.width, view.height],
            documentPixelsPerImagePixel: Number((1 / (factor * view.scale)).toFixed(4)),
        },
    };
}

tool('view_board', {
    title: 'Look at the board',
    description: 'Returns an image of the canvas so you can see what the person drew. source "auto" tries, in order: the live VS Code board (includes unsaved strokes; notes drawn as dashed boxes), a screenshot of the Compositor app window when the app has the project open, Compositor\'s own renderer on the saved project (exact, includes HDR layers the VS Code board shows only as a placeholder), saving in Compositor and reading its preview, and the preview from its last save. Use region to zoom into part of the canvas at full detail.',
    inputSchema: {
        path: projectPath,
        source: z.enum(['auto', 'vscode', 'window', 'engine', 'app-save', 'saved']).default('auto'),
        region: regionSchema.optional(),
        max_size: z.number().int().min(64).max(2576).optional().describe('Longest side of the returned image in pixels (default 1568).'),
        show_notes: z.boolean().default(true).describe('Draw pinned notes on the image (VS Code source only).'),
        show_selection: z.boolean().default(true).describe("Draw the person's current selection as marching ants (VS Code source only)."),
    },
}, async (args) => {
    const root = resolveRoot(args.path);
    const tried = [];
    const attempts = {
        vscode: () => viewFromVscode(root, args),
        window: () => viewFromWindow(root, args),
        engine: () => viewFromEngine(root, args),
        'app-save': async () => viewFromPreview(root, args, await app.saveAndReadPreview(root), 'app-save', 'Compositor saved just now'),
        saved: async () => {
            const saved = app.savedPreview(root);
            if (!saved) throw new Error('There is no saved Compositor preview (it is removed whenever the project is changed from outside the app).');
            if (!saved.fresh) throw new Error('The saved preview is older than the project.');
            return viewFromPreview(root, args, saved.jpg, 'saved', `Compositor's save at ${saved.savedAt.toISOString()}`);
        },
    };
    const order = args.source === 'auto' ? ['vscode', 'window', 'engine', 'app-save', 'saved'] : [args.source];
    for (const source of order) {
        try {
            const result = await attempts[source]();
            if (result) {
                if (tried.length) result.about.skipped = tried;
                return { content: [image(result.view), text(result.about)] };
            }
            tried.push(`${source}: not open`);
        } catch (error) {
            tried.push(`${source}: ${error.message}`);
        }
    }
    throw new Error(`Could not get a view of the board.\n- ${tried.join('\n- ')}\nYou can still read single layers with view_layer.`);
});

tool('view_layer', {
    title: 'Look at one layer',
    description: 'Returns one layer\'s own pixels (or its mask) at its stored resolution, independent of the other layers, over a checkerboard so transparency shows. Use region (in the layer\'s own pixels) to zoom in. Reads the files on disk after saving the open VS Code board.',
    inputSchema: {
        path: projectPath,
        layer: layerRef,
        target: z.enum(['image', 'mask']).default('image'),
        region: regionSchema.optional().describe('Rectangle in the layer image\'s own pixels.'),
        max_size: z.number().int().min(64).max(2576).optional(),
        background: z.enum(['checker', 'white', 'black', 'transparent']).default('checker'),
    },
}, async (args) => {
    const root = resolveRoot(args.path);
    await flushBoard(root);
    const { manifest } = io.readProject(root);
    const layer = findLayer(manifest, args.layer);
    const file = args.target === 'mask' ? layer.maskFile : layer.imageFile;
    if (!file) throw new Error(args.target === 'mask' ? `Layer "${layer.name}" has no mask.` : `Layer "${layer.name}" has no pixels (${manifests.kindOf(layer)}).`);
    if (file.endsWith('.exr')) throw new Error('This is an HDR (OpenEXR) layer; it cannot be shown here.');
    const bytes = io.readImage(root, file);
    const flat = args.target === 'mask' ? bytes : await images.flatten(bytes, args.background);
    const view = await images.prepareView(flat, { region: args.region, maxSize: args.max_size });
    const info = io.pngInfo(bytes);
    return {
        content: [image(view), text({
            layer: layer.name, id: layer.id, target: args.target,
            storedPixels: info && [info.width, info.height],
            placedAt: layer.transform,
            returnedRegion: view.region,
            layerPixelsPerImagePixel: Number((1 / view.scale).toFixed(4)),
        })],
    };
});

// ---------------------------------------------------------------------------------------------------------------
// Writing

const content = {
    svg: z.string().optional().describe('A complete <svg> document; it is stretched to the layer size, so give it viewBox="0 0 <width> <height>" to draw in layer pixels.'),
    png_path: z.string().optional().describe('Path to an image file (PNG, JPEG, WebP...) to use as the pixels.'),
    png_base64: z.string().optional().describe('Base64 image data to use as the pixels.'),
    fill: z.string().optional().describe('A CSS color to fill the whole layer with, e.g. "#1e3a8a" or "rgba(0,0,0,0.5)".'),
};

async function pixelsFrom(args, width, height) {
    if (args.svg) return images.rasterizeSvg(args.svg, width, height);
    if (args.png_path) return images.normalizePng({ path: args.png_path }, width, height);
    if (args.png_base64) return images.normalizePng({ base64: args.png_base64 }, width, height);
    if (args.fill) return images.rasterizeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${String(args.fill).replace(/"/g, '')}"/></svg>`, width, height);
    return null;
}

const blendMode = z.enum(manifests.BLEND_MODES);

tool('create_board', {
    title: 'Create a board',
    description: 'Creates a new .comp project with one background layer, then opens it as a board in a VS Code editor tab (default), the VS Code side bar, or the Compositor app.',
    inputSchema: {
        path: z.string().describe('Where to create the project; ".comp" is appended if missing.'),
        width: z.number().int().min(1).max(30000),
        height: z.number().int().min(1).max(30000),
        background: z.string().default('#ffffff').describe('A CSS color, or "transparent".'),
        open_in: z.enum(['vscode', 'sidebar', 'compositor', 'none']).default('vscode'),
    },
}, async (args) => {
    let root = path.resolve(String(args.path).replace(/^~(?=$|\/)/, process.env.HOME));
    if (!root.toLowerCase().endsWith('.comp')) root += '.comp';
    if (fs.existsSync(root)) throw new Error(`${root} already exists.`);
    if (args.width * args.height > 100000000) throw new Error('Compositor allows at most 100 million pixels.');
    const background = args.background === 'transparent' ? null : await pixelsFrom({ fill: args.background }, args.width, args.height);
    manifests.createProject(root, { width: args.width, height: args.height, backgroundPng: background });
    const opened = await openProject(root, args.open_in);
    return { content: [text({ created: root, opened })] };
});

async function openProject(root, where) {
    if (where === 'none') return 'not opened';
    if (where === 'compositor') {
        await app.openInApp(root);
        return 'Compositor app';
    }
    const host = bridge.readHosts()[0];
    if (!host) return 'not opened: no VS Code window with the Compositor Board extension is running';
    const answer = await bridge.request(host, 'POST', '/v1/open', { root, place: where === 'sidebar' ? 'sidebar' : 'editor' });
    return `VS Code ${answer && answer.place === 'sidebar' ? 'side bar' : 'editor tab'} (${host.workspace || 'window'})`;
}

tool('open_board', {
    title: 'Open a board',
    description: 'Opens a .comp project as a board in the most recently focused VS Code window (an editor tab, or the side bar), or in the Compositor app. A project already open as a board is just brought to the front.',
    inputSchema: { path: projectPath, open_in: z.enum(['vscode', 'sidebar', 'compositor']).default('vscode') },
}, async (args) => {
    const root = resolveRoot(args.path);
    return { content: [text({ opened: await openProject(root, args.open_in) })] };
});

tool('add_layer', {
    title: 'Add a layer',
    description: 'Adds a new pixel layer drawn from an SVG, an image or a fill, placed at x/y with width/height in document pixels (default: the whole canvas). Prefer one new layer per idea, named so the person can tell it is yours (e.g. "Claude: sky"), rather than painting on the person\'s layers.',
    inputSchema: {
        path: projectPath,
        name: z.string().min(1),
        ...content,
        x: z.number().default(0), y: z.number().default(0),
        width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
        opacity: z.number().min(0).max(1).default(1),
        blend_mode: blendMode.default('Normal'),
        visible: z.boolean().default(true),
        above: layerRef.optional().describe('Put the new layer directly above this one (default: top of the stack).'),
    },
}, async (args) => {
    const root = resolveRoot(args.path);
    const summary = await updateProject(root, async (manifest) => {
        const width = args.width || manifest.width;
        const height = args.height || manifest.height;
        const png = await pixelsFrom(args, width, height);
        if (!png) throw new Error('Give svg, png_path, png_base64 or fill.');
        const anchor = args.above ? findLayer(manifest, args.above) : null;
        const layer = manifests.newPixelLayer({
            name: args.name, x: args.x, y: args.y, width, height,
            opacity: args.opacity, blendMode: args.blend_mode, visible: args.visible,
            parentID: anchor ? anchor.parentID : undefined,
        });
        manifests.insertLayer(manifest, layer, anchor ? { above: anchor.id } : { top: true });
        manifest.activeLayerID = layer.id;
        return { images: { [layer.imageFile]: png }, summary: { added: layer.name, id: layer.id, transform: layer.transform } };
    });
    return { content: [text(summary)] };
});

tool('draw_on_layer', {
    title: 'Draw on an existing layer',
    description: 'Draws an SVG or image onto an existing pixel layer, over its current pixels ("over") or replacing them ("replace"). The SVG is stretched to the layer\'s stored pixel size, so use viewBox="0 0 <stored width> <stored height>" (see view_layer). Painting removes the layer\'s editable text/shape metadata, as in Compositor. Ask before drawing on the person\'s own layers.',
    inputSchema: {
        path: projectPath,
        layer: layerRef,
        ...content,
        mode: z.enum(['over', 'replace']).default('over'),
    },
}, async (args) => {
    const root = resolveRoot(args.path);
    const summary = await updateProject(root, async (manifest) => {
        const layer = findLayer(manifest, args.layer);
        const readOnly = manifests.readOnlyReason(layer);
        if (readOnly) throw new Error(`Layer "${layer.name}" cannot be painted here: ${readOnly}.`);
        let width, height, current = null;
        if (layer.imageFile) {
            current = io.readImage(root, layer.imageFile);
            ({ width, height } = io.pngInfo(current));
        } else {
            width = Math.max(1, Math.round(layer.transform.size[0]));
            height = Math.max(1, Math.round(layer.transform.size[1]));
        }
        const png = await pixelsFrom(args, width, height);
        if (!png) throw new Error('Give svg, png_path, png_base64 or fill.');
        const result = args.mode === 'over' && current ? await images.over(current, png) : png;
        manifests.markPixelsEdited(layer);
        return { images: { [layer.imageFile]: result }, summary: { drewOn: layer.name, id: layer.id, mode: args.mode, pixels: [width, height] } };
    });
    return { content: [text(summary)] };
});

tool('edit_layer', {
    title: 'Change layer properties',
    description: 'Changes a layer\'s name, visibility, opacity, blend mode, or placement (x, y, width, height in document pixels; rotation in degrees clockwise; flips). Placement changes are non-destructive, as in Compositor.',
    inputSchema: {
        path: projectPath,
        layer: layerRef,
        name: z.string().min(1).optional(),
        visible: z.boolean().optional(),
        opacity: z.number().min(0).max(1).optional(),
        blend_mode: blendMode.optional(),
        x: z.number().optional(), y: z.number().optional(),
        width: z.number().positive().optional(), height: z.number().positive().optional(),
        rotation: z.number().optional(),
        flip_x: z.boolean().optional(), flip_y: z.boolean().optional(),
    },
}, async (args) => {
    const root = resolveRoot(args.path);
    const summary = await updateProject(root, async (manifest) => {
        const layer = findLayer(manifest, args.layer);
        manifests.editLayer(layer, args);
        return { summary: { edited: layer.name, id: layer.id, now: manifests.describeLayer(layer) } };
    });
    return { content: [text(summary)] };
});

tool('remove_layer', {
    title: 'Remove a layer',
    description: 'Deletes a layer (a folder with everything inside it). The person can undo it on the VS Code board. Ask before removing the person\'s layers.',
    inputSchema: { path: projectPath, layer: layerRef },
}, async (args) => {
    const root = resolveRoot(args.path);
    const summary = await updateProject(root, async (manifest) => {
        const layer = findLayer(manifest, args.layer);
        const removed = manifests.removeLayer(manifest, layer.id);
        return { summary: { removed } };
    });
    return { content: [text(summary)] };
});

tool('move_layer', {
    title: 'Reorder a layer',
    description: 'Moves a layer within its folder: to the top or bottom, one step up or down, or directly above/below another layer of the same folder.',
    inputSchema: {
        path: projectPath,
        layer: layerRef,
        to: z.enum(['top', 'bottom', 'up', 'down', 'above', 'below']),
        other: layerRef.optional().describe('The reference layer for "above"/"below".'),
    },
}, async (args) => {
    const root = resolveRoot(args.path);
    const summary = await updateProject(root, async (manifest) => {
        const layer = findLayer(manifest, args.layer);
        const other = args.other ? findLayer(manifest, args.other) : null;
        manifests.moveLayer(manifest, layer.id, args.to, other && other.id);
        return { summary: { order: manifests.describe(manifest).layers.map((l) => l.name) } };
    });
    return { content: [text(summary)] };
});

// ---------------------------------------------------------------------------------------------------------------
// Notes: short messages pinned to a spot on the canvas, kept beside the project in <name>.comp.notes.json.

tool('add_note', {
    title: 'Pin a note on the canvas',
    description: 'Pins a short note to a rectangle (or point) of the canvas, shown on the VS Code board in Claude\'s color. Use it to answer the person\'s notes, point at something, or ask a question about an area.',
    inputSchema: {
        path: projectPath,
        text: z.string().min(1),
        x: z.number().default(0), y: z.number().default(0),
        width: z.number().min(0).default(0), height: z.number().min(0).default(0),
        reply_to: z.string().optional().describe('Id of the note this answers.'),
    },
}, async (args) => {
    const root = resolveRoot(args.path);
    const notes = io.readNotes(root);
    const note = {
        id: io.newID(), author: 'claude', text: args.text,
        x: args.x, y: args.y, width: args.width, height: args.height,
        replyTo: args.reply_to, resolved: false, createdAt: new Date().toISOString(),
    };
    notes.push(note);
    io.writeNotes(root, notes);
    return { content: [text({ pinned: note })] };
});

tool('resolve_note', {
    title: 'Resolve a note',
    description: 'Marks a note as done (it stays in the file but is hidden on the board).',
    inputSchema: { path: projectPath, id: z.string() },
}, async (args) => {
    const root = resolveRoot(args.path);
    const notes = io.readNotes(root);
    const note = notes.find((n) => n.id === args.id);
    if (!note) throw new Error(`No note ${args.id}.`);
    note.resolved = true;
    io.writeNotes(root, notes);
    return { content: [text({ resolved: note.id })] };
});

server.connect(new StdioServerTransport()).catch((error) => {
    console.error('[compositor-board] failed to start', error);
    process.exit(1);
});
