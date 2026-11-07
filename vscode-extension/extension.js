'use strict';
// Compositor Board: opens a Compositor `.comp` project as a drawing board, in an editor tab or in the side bar. The
// board itself (rendering, tools, history) runs in the webview under media/; this side owns the files on disk, undo
// and save, watching for changes made by Compositor or Claude, and the local bridge the Claude Code plugin talks to.
//
// A project is open in one place at a time: two boards would each hold their own unsaved strokes and undo history.
// Moving it between a tab and the side bar saves it first and closes the other place.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const io = require('./core/package-io');
const manifests = require('./core/manifest');
const bridge = require('./core/bridge-protocol');
const { EngineClient } = require('./core/engine-client');
const { FileCommands, RECENT_LIMIT } = require('./file-commands');
const { ClaudeSessions } = require('./claude-sessions');

const VIEW_TYPE = 'compositorBoard.board';
const SIDEBAR_VIEW = 'compositorBoard.sidebar';
const POLL_MS = 400;
const RECENT_KEY = 'compositorBoard.recent';
const SIDEBAR_KEY = 'compositorBoard.sidebarProject';
const PREFERENCES_KEY = 'compositorBoard.preferences';
// Compositor's keyboardShortcuts.v1: the person's remapped chords, the same JSON text, app-wide.
const SHORTCUTS_KEY = 'compositorBoard.keyboardShortcuts.v1';
// Each tool module may bring its own stylesheet after the board's.
const STYLES = ['board.css', 'paint-tools.css', 'crop.css', 'type-tool.css', 'adjustments.css', 'file.css', 'camera-raw.css'];
const SCRIPTS = ['geometry.js', 'blend.js', 'document.js', 'render.js', 'history.js', 'selection.js', 'brush.js', 'shapes.js', 'transform.js', 'notes.js', 'picker.js', 'shortcuts.js', 'menus.js', 'select-tools.js', 'filters.js', 'adjustments.js', 'effects.js', 'tools.js', 'paint-tools.js', 'crop.js', 'type-tool.js', 'camera-raw.js', 'pen-tool.js', 'layer-ops.js', 'layers.js', 'file.js', 'view.js', 'view-chrome.js', 'palette.js', 'proof.js', 'board.js'];

// A project open as a board, in an editor tab (`place: 'editor'`) or the side bar (`place: 'sidebar'`). Its surface
// is the webview showing it: { webview, isVisible(), isActive(), reveal() }.
class BoardDocument {
    constructor(uri, place) {
        this.uri = uri;
        this.place = place;
        this.root = io.packageRoot(uri.fsPath);
        this.name = path.basename(this.root, '.comp');
        this.surface = null;
        this.ready = Promise.resolve();
        this.pending = new Map();
        this.nextRequest = 1;
        this.dirty = false;
        this.knownHash = null;
        this.knownImages = {};
        this.knownNotes = 0;
        this.poll = null;
        this.saving = Promise.resolve();
        this.disposed = false;
        this.disposeEmitter = new vscode.EventEmitter();
        this.onDidDispose = this.disposeEmitter.event;
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        clearInterval(this.poll);
        for (const { reject } of this.pending.values()) reject(new Error('The board was closed.'));
        this.pending.clear();
        this.surface = null;
        this.disposeEmitter.fire();
        this.disposeEmitter.dispose();
    }

    post(message) {
        if (this.surface) this.surface.webview.postMessage(message);
    }

    // A request the webview answers with a `response` message carrying the same id.
    async request(kind, args = {}, timeout = 30000) {
        if (!this.surface) throw new Error('The board is not open.');
        await this.ready;
        const id = this.nextRequest++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`The board did not answer the ${kind} request.`));
            }, timeout);
            this.pending.set(id, {
                resolve: (value) => { clearTimeout(timer); resolve(value); },
                reject: (error) => { clearTimeout(timer); reject(error); },
            });
            this.post({ type: 'request', id, kind, args });
        });
    }

    // The project folder was moved or deleted while the board was open (Finder, a script, another app).
    isGone() {
        return !fs.existsSync(path.join(this.root, 'manifest.json'));
    }

    readDisk() {
        const bytes = io.readManifestBytes(this.root);
        const manifest = JSON.parse(bytes.toString('utf8'));
        const images = {};
        for (const file of io.referencedFiles(manifest)) {
            try { images[file] = new Uint8Array(io.readImage(this.root, file)); } catch { /* reported by the webview */ }
        }
        return { manifest, manifestHash: io.hash(bytes), images, stats: io.imageStats(this.root) };
    }
}

// The Claude Code chats open as tabs in this window (Claude Code's claudeVSCodePanel webviews), by the titles on their
// tabs: the one in front of the active editor group, else the one last there while it is still open.
class ClaudeTabs {
    constructor(onChange) {
        this.last = null;
        const seen = () => {
            const front = this.front();
            if (front && front !== this.last) {
                this.last = front;
                onChange();
            }
        };
        this.subscriptions = [vscode.window.tabGroups.onDidChangeTabs(seen), vscode.window.tabGroups.onDidChangeTabGroups(seen)];
        seen();
    }

    static isChat(tab) {
        return Boolean(tab && tab.input instanceof vscode.TabInputWebview && /claudeVSCodePanel$/.test(tab.input.viewType));
    }

    front() {
        const group = vscode.window.tabGroups.activeTabGroup;
        return group && ClaudeTabs.isChat(group.activeTab) ? group.activeTab.label : null;
    }

    state() {
        const open = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => ClaudeTabs.isChat(t)).map((t) => t.label);
        return { front: this.front() || (open.includes(this.last) ? this.last : null), open };
    }

    dispose() {
        for (const s of this.subscriptions) s.dispose();
    }
}

class BoardProvider {
    constructor(context) {
        this.context = context;
        this.media = vscode.Uri.joinPath(context.extensionUri, 'media');
        this.documents = new Map();
        this.changeEmitter = new vscode.EventEmitter();
        this.onDidChangeCustomDocument = this.changeEmitter.event;
        this.autosaveTimers = new Map();
        this.panelPlaces = {};
        this.sidebar = null;
        // COMPOSITOR_ENGINE points a development window at another build of the engine.
        this.engine = new EngineClient(process.env.COMPOSITOR_ENGINE || path.join(context.extensionPath, 'bin', 'compositor-engine'));
        context.subscriptions.push({ dispose: () => this.engine.stop() });
        // The text lane (text.md 10.5): a second engine process that only lays text out and lists fonts, so typing never
        // waits behind a filter or a save on the first.
        this.textEngine = new EngineClient(this.engine.binary);
        context.subscriptions.push({ dispose: () => this.textEngine.stop() });
        // File menu commands, the New Canvas tab, imports, exports and drops (file-commands.js).
        this.files = new FileCommands(this, { openBoard, manifestUri, viewType: VIEW_TYPE });
        // Send to Claude on notes: the Claude Code sessions running the board plugin (claude-sessions.js), with the
        // session each board picked kept across reloads, and this window's chat tabs, whose front one goes first. A
        // chat tab coming to the front, or renamed, has the boards show it.
        this.claudeTabs = new ClaudeTabs(() => {
            for (const document of this.documents.values()) if (!document.disposed) document.post({ type: 'claudeTabs' });
        });
        context.subscriptions.push(this.claudeTabs);
        this.claude = new ClaudeSessions(context.globalState, () => this.claudeTabs.state());
    }

    cmykFolders() {
        const app = path.join(os.homedir(), 'Library/Containers/com.wonderassembly.compositor/Data/Library/Application Support/CMYK Profiles');
        return [path.join(this.context.globalStorageUri.fsPath, 'CMYK Profiles'), ...(fs.existsSync(app) ? [app] : [])];
    }

    // View › CMYK › Profile › Load Profile… (CompositorApp.swift:398-406, IO/CMYK.swift:52-62): a CMYK output profile is
    // copied into the extension's own folder, keeping its file name, and chosen.
    async loadCMYKProfile(document) {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false, canSelectFiles: true, canSelectFolders: false,
            filters: { 'ICC Profile': ['icc', 'icm'] }, title: 'Choose a CMYK ICC profile, such as the one your printer gave you',
        });
        if (!picked || !picked[0]) return;
        const file = picked[0].fsPath;
        try {
            const { name } = await this.engine.request('cmyk.validate', { path: file });
            const folder = this.cmykFolders()[0];
            fs.mkdirSync(folder, { recursive: true });
            const target = path.join(folder, path.basename(file));
            const temp = `${target}.${process.pid}.tmp`;
            fs.copyFileSync(file, temp);
            fs.renameSync(temp, target);
            this.context.globalState.update(PREFERENCES_KEY, { ...(this.context.globalState.get(PREFERENCES_KEY) || {}), cmykProfile: name });
            document.post({ type: 'cmykLoaded', name });
        } catch (error) {
            vscode.window.showErrorMessage('Import couldn\u2019t finish', { modal: true, detail: error.message });
        }
    }

    // Canvas Only around the board (chrome.md 11.3): the workbench command the setting names runs on entering and
    // again on leaving (they are toggles); the side bar keeps the workbench as it is.
    async canvasOnly(document, on) {
        if (on && document.place === 'editor' && !document.workbenchToggled) {
            const choice = vscode.workspace.getConfiguration('compositorBoard').get('canvasOnly.workbench') || 'maximizeGroup';
            const command = { maximizeGroup: 'workbench.action.toggleMaximizeEditorGroup', zenMode: 'workbench.action.toggleZenMode', fullScreen: 'workbench.action.toggleFullScreen' }[choice];
            if (command) {
                document.workbenchToggled = command;
                await vscode.commands.executeCommand(command);
            }
        } else if (!on && document.workbenchToggled) {
            const command = document.workbenchToggled;
            document.workbenchToggled = null;
            await vscode.commands.executeCommand(command);
        }
    }

    track(document) {
        this.documents.set(document.root, document);
        document.onDidDispose(() => {
            if (this.documents.get(document.root) === document) this.documents.delete(document.root);
            clearTimeout(this.autosaveTimers.get(document.root));
            // A board closed in Canvas Only puts the workbench back.
            if (document.workbenchToggled) vscode.commands.executeCommand(document.workbenchToggled);
            // A board closed with a filter panel open: the engine lets go of that edit.
            for (const edit of document.openEdits || []) {
                this.engine.release(edit);
                if (this.engine.process) this.engine.request('filter.cancel', { edit }).catch(() => {});
            }
            for (const session of document.cameraRawSessions || []) {
                this.engine.release(session);
                if (this.engine.process) this.engine.request('filter.session.close', { session }).catch(() => {});
            }
        });
        remember(this.context, document.root);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Editor tabs (CustomEditorProvider)

    async openCustomDocument(uri) {
        const root = io.packageRoot(uri.fsPath);
        if (this.sidebar && this.sidebar.root === root) await this.sidebar.release();
        const document = new BoardDocument(uri, 'editor');
        this.track(document);
        return document;
    }

    async resolveCustomEditor(document, panel) {
        panel.webview.options = { enableScripts: true, localResourceRoots: [this.media] };
        if (document.surface) {
            panel.webview.html = this.duplicateHtml(document);
            return;
        }
        document.surface = {
            webview: panel.webview,
            isVisible: () => panel.visible,
            isActive: () => panel.active,
            reveal: () => panel.reveal(),
        };
        let markReady;
        document.ready = new Promise((resolve) => { markReady = resolve; });
        panel.onDidDispose(() => { document.surface = null; });
        // Switching away from a board's tab commits its pending transform, as switching project tabs does (chrome.md 18.1).
        panel.onDidChangeViewState(() => { if (!panel.active) document.post({ type: 'deactivate' }); });
        panel.webview.html = this.html(panel.webview);
        panel.webview.onDidReceiveMessage((message) => {
            if (message.type === 'ready') {
                this.load(document);
                markReady();
            } else this.receive(document, message);
        });
    }

    saveCustomDocument(document) {
        document.saving = document.saving.then(() => this.write(document));
        return document.saving;
    }

    async saveCustomDocumentAs(document, destination) {
        // VS Code's own Save As offers manifest.json: only a .comp package (or its manifest) is a place to save to.
        let file = destination.fsPath;
        if (file.toLowerCase().endsWith('/manifest.json')) file = path.dirname(file);
        else if (!/\.comp$/i.test(file) && !/\.[a-z0-9]+$/i.test(path.basename(file))) file += '.comp';
        if (!/\.comp$/i.test(file)) throw new Error('Save a Compositor project as a .comp package.');
        const target = file;
        await this.flush(document);
        fs.cpSync(document.root, target, { recursive: true });
    }

    async revertCustomDocument(document) {
        document.dirty = false;
        this.load(document);
    }

    async backupCustomDocument(document, context) {
        // Strokes reach the disk within the autosave delay, so a hot-exit backup reopens the saved project.
        return { id: context.destination.toString(), delete: () => {} };
    }

    async closeEditorFor(root) {
        const target = manifestUri(root).toString();
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (tab.input instanceof vscode.TabInputCustom && tab.input.viewType === VIEW_TYPE && tab.input.uri.toString() === target) {
                    await vscode.window.tabGroups.close(tab);
                }
            }
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Shared by both places

    async receive(document, message) {
        if (!document || document.disposed) return;
        switch (message.type) {
            case 'response': {
                const pending = document.pending.get(message.id);
                if (!pending) break;
                document.pending.delete(message.id);
                if (message.ok) pending.resolve(message.result);
                else pending.reject(new Error(message.error || 'The board failed.'));
                break;
            }
            case 'edit':
                this.recordEdit(document, message.label);
                this.scheduleAutosave(document);
                break;
            case 'dirty':
                // An undo or redo the side bar board made itself.
                document.dirty = true;
                this.scheduleAutosave(document);
                break;
            case 'saveNow':
                await this.flush(document);
                break;
            case 'command': {
                // Menu items whose command belongs to VS Code (Undo and Redo of the editor, the File items).
                const commands = {
                    undo: 'undo', redo: 'redo', new: 'compositorBoard.new', open: 'compositorBoard.open',
                    save: 'workbench.action.files.save', close: document.place === 'sidebar' ? 'compositorBoard.sidebar.close' : 'workbench.action.closeActiveEditor',
                };
                if (commands[message.command]) await vscode.commands.executeCommand(commands[message.command]);
                break;
            }
            case 'preferences':
                this.context.globalState.update(PREFERENCES_KEY, { ...(this.context.globalState.get(PREFERENCES_KEY) || {}), ...message.preferences });
                break;
            case 'shortcuts':
                // Shortcuts are app-wide (ShortcutSettings.shared): every open board takes them at once.
                await this.context.globalState.update(SHORTCUTS_KEY, message.json);
                for (const other of this.documents.values()) if (other !== document && !other.disposed) other.post({ type: 'shortcuts', json: message.json });
                break;
            case 'canvasOnly':
                await this.canvasOnly(document, message.on);
                break;
            case 'panelPlace':
                // Floating panel places last for the window's session, as Compositor's static dictionary does.
                this.panelPlaces[message.name] = message.place;
                break;
            case 'loadCMYKProfile':
                await this.loadCMYKProfile(document);
                break;
            case 'notes':
                io.writeNotes(document.root, message.notes);
                document.knownNotes = notesStamp(document.root);
                break;
            case 'boardState':
                // Layer locks, Pen paths and outlined shapes (board choices): only the board writes them, so nothing polls the file.
                io.writeBoardState(document.root, message.state);
                break;
            case 'claude':
                // Send to Claude on a note: the sessions to offer, the board's session pinned (or unpinned with null),
                // or one note sent to a session (claude-sessions.js).
                try {
                    let result;
                    if (message.op === 'sessions') result = this.claude.menu(document.root);
                    else if (message.op === 'pin') { this.claude.pin(document.root, message.to); result = this.claude.menu(document.root); }
                    else result = await this.claude.send(document.root, message.note, message.to);
                    document.post({ type: 'claudeResult', id: message.id, ok: true, result });
                } catch (error) {
                    document.post({ type: 'claudeResult', id: message.id, ok: false, error: error.message });
                }
                break;
            case 'openInCompositor':
                await this.flush(document);
                openInCompositor(document.root);
                break;
            case 'moveToSidebar':
                await this.showInSidebar(document.root);
                break;
            case 'moveToEditor':
                await this.moveToEditor(document.root);
                break;
            case 'warning':
                vscode.window.showWarningMessage(message.message);
                break;
            case 'engine':
                this.runEngine(document, message);
                break;
            case 'textEngine':
                // text.layout and text.fonts read no project: no flush, no busy state, straight to the text lane.
                if (message.op === 'text.layout' || message.op === 'text.fonts') {
                    this.textEngine.request(message.op, message.args || {})
                        .then((result) => document.post({ type: 'textEngineResult', id: message.id, ok: true, result }))
                        .catch((error) => document.post({ type: 'textEngineResult', id: message.id, ok: false, error: error.message }));
                }
                break;
            case 'closeGone':
                await this.closeGone(document);
                break;
            case 'fileCommand':
            case 'fileRequest':
            case 'fileEngine':
            case 'createCanvas':
            case 'importDrop':
                await this.files.receive(message, { post: (m) => document.post(m), place: document.place, document });
                break;
        }
    }

    // An operation run by Compositor's own code: the board's unsaved strokes are written first, the engine works on the
    // project with the board's active layer and selection, and what it saved comes back to the board as one undo step
    // named after the operation. Its answer (a new selection, for instance) goes back to the board.
    async runEngine(document, { id, op, args, label, files, stateless }) {
        const reply = (body) => document.post({ type: 'engineResult', id, ...body });
        document.engineBusy = (document.engineBusy || 0) + 1;
        try {
            if (document.missing || document.isGone()) {
                if (!document.missing) this.projectGone(document);
                throw new Error(`This project is no longer at ${document.root}: it was moved or deleted, so nothing here can be changed. Close this board and open the project where it is now.`);
            }
            // Geometry-only operations (selection booleans) never read the project, so unsaved strokes can wait.
            if (!stateless) await this.flush(document);
            const temp = {};
            for (const [key, extension] of Object.entries(files || {})) temp[key] = this.engine.tempFile(extension);
            const selectionOut = this.engine.tempFile('json');
            const extra = { selectionOut };
            // CMYK profiles: the system's, the ones loaded here, and the Compositor app's own (chrome.md 12.6).
            if (op.startsWith('cmyk.')) extra.folders = this.cmykFolders();
            // The clipboard belongs to this VS Code window, so Paste knows what any of its boards last copied.
            if (op === 'selection.paste') extra.clip = this.clipboard || null;
            // Imports, RAW develops and exports can run for minutes (file.md 15.1 item 2).
            const timeout = /^(import|export|project|psd|raw)\./.test(op) ? 600000 : undefined;
            const result = await this.engine.request(op, { project: document.root, ...args, ...temp, ...extra }, { timeout });
            if (result && result.selection && result.selection.file) {
                result.selection = JSON.parse(fs.readFileSync(selectionOut, 'utf8'));
            }
            fs.rmSync(selectionOut, { force: true });
            // A filter panel keeps its edit open in the engine until OK or Cancel.
            if (op === 'filter.begin' && result && result.edit) {
                this.engine.hold(result.edit);
                document.openEdits = (document.openEdits || new Set()).add(result.edit);
            }
            if ((op === 'filter.commit' && result && !result.open) || op === 'filter.cancel') {
                this.engine.release(args.edit);
                if (document.openEdits) document.openEdits.delete(args.edit);
            }
            // Camera Raw keeps a live session in the engine until OK or Cancel (camera-raw.md 18.2).
            if (op === 'filter.session.open' && result && result.session) {
                this.engine.hold(result.session);
                document.cameraRawSessions = (document.cameraRawSessions || new Set()).add(result.session);
            }
            if ((op === 'filter.session.commit' || op === 'filter.session.close') && args.session) {
                this.engine.release(args.session);
                if (document.cameraRawSessions) document.cameraRawSessions.delete(args.session);
            }
            if ((op === 'selection.copy' || op === 'selection.cut') && result) {
                this.clipboard = { changeCount: result.changeCount, origin: result.origin, project: document.root, copiedLayerIDs: result.copiedLayerIDs };
            }
            if (result && result.saved) {
                await document.saving;
                await this.pushExternal(document, result.editName || label, result.changedFiles);
            }
            const attachments = {};
            for (const [key, file] of Object.entries(temp)) {
                if (fs.existsSync(file)) {
                    attachments[key] = new Uint8Array(fs.readFileSync(file));
                    fs.rmSync(file, { force: true });
                }
            }
            reply({ ok: true, result, files: attachments });
        } catch (error) {
            reply({ ok: false, error: error.message });
        } finally {
            document.engineBusy -= 1;
        }
    }

    load(document) {
        if (document.isGone()) {
            this.projectGone(document);
            return;
        }
        let disk;
        try {
            disk = document.readDisk();
        } catch (error) {
            document.post({ type: 'fatal', message: `Could not open ${document.name}.comp: ${error.message}` });
            return;
        }
        document.knownHash = disk.manifestHash;
        document.knownImages = disk.stats;
        document.knownNotes = notesStamp(document.root);
        const settings = vscode.workspace.getConfiguration('compositorBoard');
        document.post({
            type: 'load',
            name: document.name,
            root: document.root,
            place: document.place,
            manifest: disk.manifest,
            manifestHash: disk.manifestHash,
            images: disk.images,
            notes: io.readNotes(document.root),
            boardState: io.readBoardState(document.root),
            // DocumentLimits.documentPixelBudget: 200-800 megapixels by this Mac's memory.
            settings: {
                checkerboard: settings.get('checkerboard'),
                pixelBudget: Math.min(800e6, Math.max(200e6, Math.floor(os.totalmem() / 16))),
                preferences: this.context.globalState.get(PREFERENCES_KEY) || {},
                shortcuts: this.context.globalState.get(SHORTCUTS_KEY) || '',
                panelPlaces: this.panelPlaces,
            },
        });
        clearInterval(document.poll);
        document.poll = setInterval(() => this.checkDisk(document), POLL_MS);
    }

    // Polls the package: Compositor replaces the whole folder when it saves, which file watchers lose track of.
    async checkDisk(document) {
        // While the engine works on the files, its own result is handed over with the operation's name instead.
        if (document.checking || !document.surface || document.engineBusy) return;
        document.checking = true;
        try {
            const stamp = notesStamp(document.root);
            if (stamp !== document.knownNotes) {
                document.knownNotes = stamp;
                document.post({ type: 'notes', notes: io.readNotes(document.root) });
            }
            if (document.isGone()) {
                if (!document.missing) this.projectGone(document);
                return;
            }
            if (document.missing) {
                // Back where it was (moved back, or restored): pick up whatever is there now.
                document.missing = false;
                document.post({ type: 'found' });
            }
            let bytes;
            try { bytes = io.readManifestBytes(document.root); } catch { return; }
            const hash = io.hash(bytes);
            const stats = io.imageStats(document.root);
            if (hash === document.knownHash && sameImages(stats, document.knownImages)) return;
            await document.saving;
            await this.pushExternal(document);
        } catch (error) {
            console.error('[compositor-board] checking the project failed', error);
        } finally {
            document.checking = false;
        }
    }

    // Nothing can be saved or changed any more: say so on the board instead of failing at every save and engine call.
    projectGone(document) {
        document.missing = true;
        document.dirty = false;
        clearTimeout(this.autosaveTimers.get(document.root));
        document.post({ type: 'missing', root: document.root });
    }

    // The board's Close button: a tab is saved first (a no-op now) so VS Code closes it without asking about edits.
    async closeGone(document) {
        if (document.place === 'sidebar') {
            await this.sidebar.release();
            return;
        }
        await vscode.workspace.save(document.uri).then(undefined, () => {});
        await this.closeEditorFor(document.root);
    }

    // Hands the disk version to the webview, which merges it with any strokes of its own and records it in history.
    // `only`: the files an engine edit changed (it rewrites the whole package, so sizes and dates say nothing).
    async pushExternal(document, label, only) {
        const disk = document.readDisk();
        const changed = {};
        for (const [file, bytes] of Object.entries(disk.images)) {
            const before = document.knownImages[file];
            const now = disk.stats[file];
            if (only) { if (only.includes(file)) changed[file] = bytes; continue; }
            if (!before || !now || before.size !== now.size || before.mtimeMs !== now.mtimeMs) changed[file] = bytes;
        }
        const result = await document.request('external', {
            manifest: disk.manifest,
            manifestHash: disk.manifestHash,
            images: changed,
            label,
        });
        document.knownHash = disk.manifestHash;
        document.knownImages = disk.stats;
        if (result && result.edited) {
            this.recordEdit(document, result.label);
            // A merge that kept local strokes needs saving; a plain reload matches the disk already, but VS Code counts
            // the recorded step as unsaved, so the same autosave (writing nothing) puts its tab back to saved.
            if (!result.dirty) document.dirty = false;
            this.scheduleAutosave(document);
        }
    }

    // A tab's edit is one step on VS Code's undo stack, and undoing or redoing it is saved like any edit. The side bar
    // has no such stack, so its board keeps its own history and only reports that it needs saving.
    recordEdit(document, label) {
        document.dirty = true;
        if (document.place !== 'editor') return;
        const step = (type) => () => {
            document.dirty = true;
            document.post({ type });
            this.scheduleAutosave(document);
        };
        this.changeEmitter.fire({ document, label, undo: step('undo'), redo: step('redo') });
    }

    scheduleAutosave(document) {
        const delay = vscode.workspace.getConfiguration('compositorBoard').get('autosaveDelay');
        clearTimeout(this.autosaveTimers.get(document.root));
        // The side bar has no Save command of its own, so it always saves on its own.
        const wait = document.place === 'editor' ? delay : Math.max(delay || 0, 300);
        if (!wait || wait < 0) return;
        this.autosaveTimers.set(document.root, setTimeout(() => {
            this.save(document).then(undefined, (error) => console.error('[compositor-board] autosave failed', error));
        }, wait));
    }

    save(document) {
        if (document.place === 'editor') return vscode.workspace.save(document.uri);
        document.saving = document.saving.then(() => this.write(document));
        return document.saving;
    }

    // Writes unsaved strokes now, for a caller that is about to read or change the files.
    async flush(document) {
        clearTimeout(this.autosaveTimers.get(document.root));
        if (document.dirty) await this.save(document);
        await document.saving;
    }

    async write(document) {
        if (document.missing || document.isGone()) {
            if (!document.missing) this.projectGone(document);
            document.dirty = false;
            return;
        }
        for (let attempt = 0; attempt < 4; attempt++) {
            const data = await document.request('save');
            if (!data.changed) {
                document.dirty = false;
                return;
            }
            const images = {};
            for (const [file, bytes] of Object.entries(data.images)) images[file] = Buffer.from(bytes);
            manifests.prepareForWrite(data.manifest);
            const problems = manifests.validate(data.manifest, { images: describeImages(document.root, data.manifest, images) });
            if (problems.length) {
                vscode.window.showErrorMessage('Couldn’t save the project', { modal: true, detail: `Compositor would refuse this project, so it was not saved: ${problems[0]}` });
                throw new Error(problems.join('; '));
            }
            try {
                const { manifestHash } = io.writeProject(document.root, data.manifest, images, { expectHash: data.baseHash });
                document.knownHash = manifestHash;
                document.knownImages = io.imageStats(document.root);
                document.dirty = false;
                document.post({ type: 'saved', manifestHash, files: Object.keys(images) });
                this.files.afterWrite(document);
                return;
            } catch (error) {
                if (error.code !== 'ECONFLICT') throw error;
                await this.pushExternal(document);
            }
        }
        throw new Error('The project kept changing on disk while saving.');
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Moving a project between a tab and the side bar

    async showInSidebar(root) {
        const open = this.documents.get(root);
        if (open && open.place === 'editor') {
            await this.flush(open);
            await this.closeEditorFor(root);
        }
        await this.sidebar.show(root);
    }

    async moveToEditor(root, column) {
        if (this.sidebar.root === root) await this.sidebar.release();
        await openBoard(root, column);
    }

    html(webview) {
        const nonce = crypto.randomBytes(16).toString('base64');
        const uri = (file) => webview.asWebviewUri(vscode.Uri.joinPath(this.media, file));
        const scripts = SCRIPTS.map((file) => `<script nonce="${nonce}" src="${uri(file)}"></script>`).join('\n    ');
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob: data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${STYLES.map((file) => `<link rel="stylesheet" href="${uri(file)}">`).join('\n    ')}
    <title>Compositor Board</title>
</head>
<body>
    <div id="app"></div>
    ${scripts}
</body>
</html>`;
    }

    duplicateHtml(document) {
        return `<!DOCTYPE html><html><body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px">
<p>${escapeHtml(document.name)}.comp is already open in another tab. A project has one board at a time, so strokes are never split between two tabs.</p></body></html>`;
    }
}

// The board in the side bar (a WebviewView). It shows one project at a time, remembers it across sessions, and shows
// recent projects when none is open.
class SidebarBoard {
    constructor(provider) {
        this.provider = provider;
        this.view = null;
        this.document = null;
        this.webviewReady = false;
        this.waiting = [];
    }

    get root() {
        return this.document ? this.document.root : null;
    }

    resolveWebviewView(view) {
        this.view = view;
        this.webviewReady = false;
        view.webview.options = { enableScripts: true, localResourceRoots: [this.provider.media] };
        view.webview.html = this.provider.html(view.webview);
        view.webview.onDidReceiveMessage((message) => this.receive(message));
        view.onDidDispose(() => {
            if (this.document) this.document.dispose();
            this.document = null;
            this.view = null;
            this.webviewReady = false;
        });
    }

    async receive(message) {
        switch (message.type) {
            case 'ready': {
                this.webviewReady = true;
                for (const resolve of this.waiting.splice(0)) resolve();
                const last = this.provider.context.globalState.get(SIDEBAR_KEY);
                if (!this.document && last && fs.existsSync(path.join(last, io.MANIFEST)) && !this.provider.documents.has(last)) await this.show(last);
                else if (this.document) this.provider.load(this.document);
                else this.showEmpty();
                break;
            }
            case 'pickProject':
                await this.provider.files.openProjects(null, null, this.fileSurface());
                break;
            case 'openRecent':
                if (message.root && fs.existsSync(path.join(message.root, io.MANIFEST))) await this.provider.files.openRoots([message.root], this.fileSurface());
                else this.showEmpty();
                break;
            case 'fileCommand':
            case 'fileRequest':
            case 'fileEngine':
            case 'createCanvas':
            case 'importDrop':
                await this.provider.files.receive(message, this.fileSurface());
                break;
            default:
                this.provider.receive(this.document, message);
        }
    }

    // Where the file commands answer: this view, with or without a project in it.
    fileSurface() {
        return { post: (m) => this.view && this.view.webview.postMessage(m), place: 'sidebar', document: this.document };
    }

    // Resolves once the view's webview is up, opening the view if it has never been shown.
    async ensureView() {
        if (this.view && this.webviewReady) {
            this.view.show(true);
            return;
        }
        const ready = new Promise((resolve) => this.waiting.push(resolve));
        await vscode.commands.executeCommand(`${SIDEBAR_VIEW}.focus`);
        await ready;
    }

    async show(root) {
        if (this.root === root) {
            await this.ensureView();
            return;
        }
        if (this.document) await this.release({ quiet: true });
        await this.ensureView();
        const view = this.view;
        const document = new BoardDocument(manifestUri(root), 'sidebar');
        document.surface = {
            webview: view.webview,
            isVisible: () => view.visible,
            isActive: () => view.visible,
            reveal: () => view.show(true),
        };
        this.document = document;
        this.provider.track(document);
        this.provider.context.globalState.update(SIDEBAR_KEY, root);
        view.description = document.name;
        this.provider.load(document);
    }

    // Saves and closes the project shown here, leaving the welcome view.
    async release({ quiet = false } = {}) {
        const document = this.document;
        if (!document) return;
        try { await this.provider.flush(document); } catch (error) { console.error('[compositor-board] saving before closing failed', error); }
        document.dispose();
        this.document = null;
        this.provider.context.globalState.update(SIDEBAR_KEY, undefined);
        if (this.view) this.view.description = undefined;
        if (!quiet) this.showEmpty();
    }

    showEmpty() {
        if (!this.view) return;
        const recent = (this.provider.context.globalState.get(RECENT_KEY) || [])
            .filter((root) => fs.existsSync(path.join(root, io.MANIFEST)))
            .map((root) => ({ root, name: path.basename(root, '.comp'), folder: path.dirname(root) }));
        this.view.webview.postMessage({ type: 'empty', recent });
    }
}

function remember(context, root) {
    const list = (context.globalState.get(RECENT_KEY) || []).filter((r) => r !== root);
    list.unshift(root);
    context.globalState.update(RECENT_KEY, list.slice(0, RECENT_LIMIT));
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function notesStamp(root) {
    try {
        const stat = fs.statSync(io.notesPath(root));
        return stat.mtimeMs + stat.size;
    } catch {
        return 0;
    }
}

function sameImages(a, b) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => b[k] && a[k].size === b[k].size && a[k].mtimeMs === b[k].mtimeMs);
}

// PNG headers of the images a save will reference: new bytes where given, otherwise the files already on disk.
function describeImages(root, manifest, images) {
    const info = {};
    for (const file of io.referencedFiles(manifest)) {
        try {
            const bytes = images[file] || io.readImage(root, file);
            info[file] = file.endsWith('.exr') ? { exr: true } : io.pngInfo(bytes);
        } catch {
            info[file] = null;
        }
    }
    return info;
}

function openInCompositor(root) {
    require('child_process').execFile('open', ['-a', 'Compositor', root], (error) => {
        if (error) vscode.window.showErrorMessage('Could not open Compositor. Install it with: brew install --cask robbietilton-compositor');
    });
}

function manifestUri(root) {
    return vscode.Uri.file(path.join(root, io.MANIFEST));
}

async function openBoard(root, column) {
    await vscode.commands.executeCommand('vscode.openWith', manifestUri(root), VIEW_TYPE, column);
}

async function pickPackage(uri) {
    if (uri && uri.fsPath) return io.packageRoot(uri.fsPath);
    const picked = await vscode.window.showOpenDialog({
        title: 'Open a Compositor project',
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Open Board',
    });
    return picked && picked[0] ? io.packageRoot(picked[0].fsPath) : null;
}

// The HTTP side of the bridge (see core/bridge-protocol.js). Only this machine can reach it, and only with the token.
function startBridge(provider, context) {
    const token = crypto.randomBytes(24).toString('hex');
    let focusedAt = vscode.window.state.focused ? Date.now() : 0;
    let port = 0;
    const publish = () => port && bridge.writeHost({ pid: process.pid, port, token, focusedAt, workspace: vscode.workspace.name || null });

    const routes = {
        'GET /v1/boards': async () => ({
            boards: [...provider.documents.values()].filter((d) => d.surface).map((d) => ({
                root: d.root,
                name: d.name,
                place: d.place,
                dirty: d.dirty,
                visible: d.surface.isVisible(),
                active: d.surface.isActive(),
            })),
        }),
        'POST /v1/capture': async (body) => {
            const document = documentFor(body.root);
            const result = await document.request('capture', {
                maxSize: body.maxSize, region: body.region, showNotes: body.showNotes !== false, background: body.background,
            });
            return { ...result, png: Buffer.from(result.png).toString('base64'), dirty: document.dirty };
        },
        'POST /v1/flush': async (body) => {
            const document = documentFor(body.root);
            const wasDirty = document.dirty;
            await provider.flush(document);
            return { saved: wasDirty };
        },
        'POST /v1/open': async (body) => {
            const root = io.packageRoot(body.root);
            const open = provider.documents.get(root);
            if (open && open.surface) open.surface.reveal();
            else if (body.place === 'sidebar') await provider.showInSidebar(root);
            else await openBoard(root);
            return { opened: true, place: (provider.documents.get(root) || {}).place || 'editor' };
        },
        'POST /v1/state': async (body) => documentFor(body.root).request('state'),
    };

    function documentFor(root) {
        const document = root && provider.documents.get(path.resolve(root));
        if (!document || !document.surface) {
            const error = new Error('That project is not open as a board in this VS Code window.');
            error.status = 404;
            error.code = 'ENOTOPEN';
            throw error;
        }
        return document;
    }

    const server = http.createServer((req, res) => {
        const reply = (status, data) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(data));
        };
        const supplied = String(req.headers.authorization || '').replace(/^Bearer /, '');
        if (supplied.length !== token.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
            reply(401, { error: 'Bad token.' });
            return;
        }
        const handler = routes[`${req.method} ${req.url}`];
        if (!handler) {
            reply(404, { error: 'No such route.' });
            return;
        }
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
            try {
                const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
                reply(200, await handler(body));
            } catch (error) {
                reply(error.status || 500, { error: error.message, code: error.code });
            }
        });
    });
    server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        publish();
    });
    context.subscriptions.push(vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
            focusedAt = Date.now();
            publish();
        }
    }));
    context.subscriptions.push({ dispose: () => { server.close(); bridge.removeHost(process.pid); } });
}

function activate(context) {
    const provider = new BoardProvider(context);
    const sidebar = new SidebarBoard(provider);
    provider.sidebar = sidebar;
    const command = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
    }));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW, sidebar, {
        webviewOptions: { retainContextWhenHidden: true },
    }));
    provider.files.register(command);
    command('compositorBoard.showInSidebar', async (uri) => {
        const root = await pickPackage(uri);
        if (root) await provider.showInSidebar(root);
    });
    command('compositorBoard.sidebar.openInEditor', async () => {
        if (sidebar.root) await provider.moveToEditor(sidebar.root);
    });
    command('compositorBoard.sidebar.close', () => sidebar.release());
    command('compositorBoard.openInCompositor', async (uri) => {
        const root = uri && uri.fsPath ? io.packageRoot(uri.fsPath) : sidebar.root || await pickPackage();
        if (!root) return;
        const document = provider.documents.get(root);
        if (document) await provider.flush(document);
        openInCompositor(root);
    });
    if (vscode.workspace.getConfiguration('compositorBoard').get('bridge')) startBridge(provider, context);
}

function deactivate() {
    bridge.removeHost(process.pid);
}

module.exports = { activate, deactivate };
