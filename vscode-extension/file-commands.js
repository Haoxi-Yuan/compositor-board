'use strict';
// The File menu's commands for boards (docs/port-specs/file.md sections 3-12 and 14): the New Canvas tab, Open Project
// and Open Recent, Import Images and New Board from Image, Save Project As, Export PNG, the save dialog of the board's
// Export As sheet, drops onto a board, and the QuickLook preview written after the board saves. Compositor's own code
// does the reading and writing in compositor-engine (engine/Sources/FileOps.swift); the board shows the sheets
// (media/file.js), this side shows VS Code's dialogs.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const io = require('./core/package-io');
const manifests = require('./core/manifest');

const RECENT_KEY = 'compositorBoard.recent';
const PREFERENCES_KEY = 'compositorBoard.preferences';
// macOS's default number of recent items (file.md 4.4).
const RECENT_LIMIT = 10;
// RAW develops, large PSDs and 200-megapixel exports can take minutes (file.md 15.1 item 2).
const LONG = 10 * 60 * 1000;
const EXTENSIONS = { JPEG: 'jpeg', PNG: 'png', TIFF: 'tiff', PDF: 'pdf', EXR: 'exr' };

// The recent list, newest first, at most RECENT_LIMIT, kept to projects still on disk.
function recentList(context) {
    return (context.globalState.get(RECENT_KEY) || []).filter((root) => fs.existsSync(path.join(root, io.MANIFEST)));
}

function remember(context, root) {
    const list = (context.globalState.get(RECENT_KEY) || []).filter((r) => r !== root);
    list.unshift(root);
    context.globalState.update(RECENT_KEY, list.slice(0, RECENT_LIMIT));
}

function forget(context, root) {
    context.globalState.update(RECENT_KEY, (context.globalState.get(RECENT_KEY) || []).filter((r) => r !== root));
}

// The lowest free "Untitled.comp", "Untitled 2.comp", ... in `folder` (ProjectWorkspace.freeUntitledName).
function untitled(folder) {
    if (!fs.existsSync(path.join(folder, 'Untitled.comp'))) return path.join(folder, 'Untitled.comp');
    for (let n = 2; ; n++) if (!fs.existsSync(path.join(folder, `Untitled ${n}.comp`))) return path.join(folder, `Untitled ${n}.comp`);
}

function workspaceFolder() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length ? folders[0].uri.fsPath : os.homedir();
}

const modal = (title, detail) => vscode.window.showWarningMessage(title, { modal: true, detail });

class FileCommands {
    // `helpers`: { openBoard(root, column), manifestUri(root), viewType }.
    constructor(provider, helpers) {
        this.provider = provider;
        this.context = provider.context;
        this.helpers = helpers;
        this.quickLookTimers = new Map();
        this.lastExportFolder = null;
    }

    get engine() {
        return this.provider.engine;
    }

    register(command) {
        command('compositorBoard.new', () => this.newCanvas());
        command('compositorBoard.open', (uri, uris) => this.openProjects(uri, uris));
        command('compositorBoard.openRecent', () => this.openRecent());
        command('compositorBoard.clearRecent', () => this.context.globalState.update(RECENT_KEY, []));
        command('compositorBoard.importImages', (uri, uris) => this.importImages(uri, uris));
        command('compositorBoard.newFromImages', (uri, uris) => this.newFromImages(uri, uris));
        command('compositorBoard.saveAs', () => this.saveAs(this.currentBoard()));
        command('compositorBoard.exportPNG', () => this.exportPNG(this.currentBoard()));
        command('compositorBoard.exportJPEG', () => this.boardAction('exportJPEG'));
        command('compositorBoard.exportAs', () => this.boardAction('exportAs'));
        command('compositorBoard.closeBoard', () => this.closeBoard(this.currentBoard()));
        // A board tab is active, or the side bar shows one (its webview may still be loading: the tab is what counts).
        const update = () => {
            const group = vscode.window.tabGroups.activeTabGroup;
            const tab = group && group.activeTab;
            const boardTab = Boolean(tab && tab.input instanceof vscode.TabInputCustom && tab.input.viewType === this.helpers.viewType);
            const side = this.provider.sidebar && this.provider.sidebar.document;
            vscode.commands.executeCommand('setContext', 'compositorBoard.hasBoard', boardTab || Boolean(side));
        };
        this.updateContext = update;
        this.context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(update), vscode.window.tabGroups.onDidChangeTabGroups(update));
        update();
    }

    // The board a command acts on: the active board tab, else the side bar's board while it shows (file.md 14.1).
    currentBoard() {
        const group = vscode.window.tabGroups.activeTabGroup;
        const tab = group && group.activeTab;
        if (tab && tab.input instanceof vscode.TabInputCustom && tab.input.viewType === this.helpers.viewType) {
            try {
                const document = this.provider.documents.get(io.packageRoot(tab.input.uri.fsPath));
                if (document && document.surface) return document;
            } catch { /* not a package */ }
        }
        const side = this.provider.sidebar && this.provider.sidebar.document;
        return side && side.surface && side.surface.isVisible() ? side : null;
    }

    // A command that needs a board: "Open a board first." (port text, file.md 14.1).
    needBoard(document) {
        if (document) return true;
        vscode.window.showInformationMessage('Open a board first.');
        return false;
    }

    boardAction(action) {
        const document = this.currentBoard();
        if (this.needBoard(document)) document.post({ type: 'fileAction', action });
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Messages from boards, the New Canvas tab and the side bar's welcome view

    // `surface`: { post(message), place: 'editor' | 'sidebar' | 'panel', document, panel, column }.
    async receive(message, surface) {
        switch (message.type) {
            case 'fileCommand':
                await this.command(message, surface);
                break;
            case 'fileRequest': {
                let reply;
                try {
                    reply = { ok: true, result: await this.request(message.command, message.args || {}, surface) };
                } catch (error) {
                    reply = { ok: false, error: error.message };
                }
                surface.post({ type: 'fileResult', id: message.id, ...reply });
                break;
            }
            case 'fileEngine':
                await this.fileEngine(message, surface);
                break;
            case 'createCanvas':
                await this.createCanvas(message, surface);
                break;
            case 'importDrop':
                await this.drop(message, surface);
                break;
        }
    }

    async command({ command, args = {} }, surface) {
        const document = surface.document;
        switch (command) {
            case 'new': return this.newCanvas();
            case 'open': return this.openProjects(null, null, surface);
            case 'openRecent': return this.openRecent(surface);
            case 'importImages': return this.importImages(null, null, surface);
            case 'saveAs': return this.saveAs(document);
            case 'exportPNG': return this.exportPNG(document);
            case 'openRoot': return this.openRoots([args.root], surface);
            default: return null;
        }
    }

    async request(command, args, surface) {
        switch (command) {
            case 'alert':
                await modal(args.title, args.text);
                return {};
            case 'fromImages': return this.projectFromImages(args, surface);
            case 'fromClipboard': return this.projectFromClipboard(surface);
            case 'exportContext': {
                const prefs = this.context.globalState.get(PREFERENCES_KEY) || {};
                const quality = Number(prefs.jpegExportQuality);
                return {
                    profileFolders: this.provider.cmykFolders(),
                    jpegQuality: Number.isFinite(quality) ? Math.min(1, Math.max(0, quality)) : 0.85,
                    cmykProfile: typeof prefs.cmykProfile === 'string' ? prefs.cmykProfile : null,
                };
            }
            case 'exportSave': return this.exportSave(args, surface.document);
            case 'loadProfile': return this.loadProfile(surface);
            case 'pickTargetFiles': return this.pickTargetFiles(surface.document);
            case 'cleanup':
                for (const dir of args.temp || []) if (dir && dir.startsWith(this.tempRoot())) fs.rmSync(dir, { recursive: true, force: true });
                return {};
            default: throw new Error(`Unknown file request ${command}.`);
        }
    }

    // Notes › Edit target › Choose Files…: the files or folders the person's notes are about, relative to the folder
    // holding the project (core/note-target.js). The picker starts in the project's workspace folder.
    async pickTargetFiles(document) {
        if (!document) return { files: null };
        const folder = path.dirname(document.root);
        const workspace = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(document.root));
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: true, canSelectFolders: true, canSelectMany: true,
            defaultUri: workspace ? workspace.uri : vscode.Uri.file(folder),
            openLabel: 'Set as Edit Target', title: 'The files Claude should change for these notes',
        });
        if (!picked || !picked.length) return { files: null };
        return { files: picked.map((uri) => path.relative(folder, uri.fsPath)) };
    }

    // An engine operation with no project behind it (the welcome view, the New Canvas tab) or that reads its project
    // as saved: no flush, no undo step. Answers as the board's own engine calls do.
    async fileEngine({ id, op, args, files }, surface) {
        const temp = {};
        try {
            for (const [key, extension] of Object.entries(files || {})) temp[key] = this.engine.tempFile(extension);
            const project = surface.document ? { project: surface.document.root } : {};
            const result = await this.engine.request(op, { ...project, ...(args || {}), ...temp }, { timeout: LONG });
            const attachments = {};
            for (const [key, file] of Object.entries(temp)) {
                if (fs.existsSync(file)) attachments[key] = new Uint8Array(fs.readFileSync(file));
            }
            surface.post({ type: 'engineResult', id, ok: true, result, files: attachments });
        } catch (error) {
            surface.post({ type: 'engineResult', id, ok: false, error: error.message });
        } finally {
            for (const file of Object.values(temp)) fs.rmSync(file, { force: true });
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // New canvas (file.md 3.11)

    // A "New Canvas" tab showing the board's New canvas form (the welcome view of a board with no project). `options`:
    // { importPaths, beside } to start importing at once (New Board from Image, Import with no board open).
    newCanvas(options = {}) {
        const panel = vscode.window.createWebviewPanel('compositorBoard.newCanvas', 'New Canvas', vscode.ViewColumn.Active, {
            enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.provider.media],
        });
        const surface = { place: 'panel', panel, document: null, beside: options.beside || null, post: (m) => panel.webview.postMessage(m) };
        panel.webview.html = this.provider.html(panel.webview);
        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.type === 'ready') {
                surface.post({ type: 'empty', recent: this.recentEntries(), newCanvas: true });
                if (options.importPaths) surface.post({ type: 'importFiles', paths: options.importPaths, point: null });
            } else if (message.type === 'pickProject') await this.openProjects(null, null, surface);
            else if (message.type === 'openRecent') await this.openRoots([message.root], surface);
            else if (message.type === 'preferences') {
                await this.context.globalState.update(PREFERENCES_KEY, { ...(this.context.globalState.get(PREFERENCES_KEY) || {}), ...message.preferences });
            } else await this.receive(message, surface);
        });
        return panel;
    }

    recentEntries() {
        return recentList(this.context).map((root) => ({ root, name: path.basename(root, '.comp'), folder: path.dirname(root) }));
    }

    // Where a new project goes: VS Code's save dialog ("Save Project", file.md 14.3), `.comp` added, an existing package
    // replaced only after the dialog asked (its board closed first).
    async askLocation(defaultPath, title = 'Save Project', saveLabel = 'Create') {
        const target = await vscode.window.showSaveDialog({
            title, saveLabel, defaultUri: vscode.Uri.file(defaultPath), filters: { 'Compositor Project': ['comp'] },
        });
        if (!target) return null;
        let root = target.fsPath;
        if (!root.toLowerCase().endsWith('.comp')) root += '.comp';
        if (fs.existsSync(root)) {
            await this.closeBoardAt(root);
            fs.rmSync(root, { recursive: true, force: true });
        }
        return root;
    }

    async closeBoardAt(root) {
        const open = this.provider.documents.get(root);
        if (!open) return;
        if (open.place === 'sidebar') await this.provider.sidebar.release({ quiet: true });
        else {
            await vscode.workspace.save(open.uri).then(undefined, () => {});
            await this.provider.closeEditorFor(root);
        }
    }

    // Create canvas: the package made where the person says, then the board shown where the form was.
    async createCanvas({ width, height, resolution, background }, surface) {
        const root = await this.askLocation(untitled(workspaceFolder()));
        if (!root) return;
        try {
            if (background === 'white' || background === 'black') {
                // A filled first layer at full size (EditorSession.createDocument), made by Compositor's own code.
                await this.engine.request('project.create', { target: root, width, height, resolution, background }, { timeout: LONG });
            } else {
                manifests.createProject(root, { width, height, resolution });
            }
        } catch (error) {
            await modal('Couldn’t save the project', error.message);
            return;
        }
        await this.showNew(root, surface);
    }

    // A new project opens where it was asked for: the side bar, or the New Canvas tab's place (which it replaces).
    async showNew(root, surface) {
        remember(this.context, root);
        if (surface.place === 'sidebar') { await this.provider.showInSidebar(root); if (this.updateContext) this.updateContext(); }
        else {
            const column = surface.panel ? surface.panel.viewColumn : undefined;
            await this.helpers.openBoard(root, column);
            if (surface.panel) surface.panel.dispose();
        }
    }

    // ⌘V on the New canvas form with an image copied (SelectionClipboard.pasteImageAsNewCanvas).
    async projectFromClipboard(surface) {
        const root = await this.askLocation(untitled(workspaceFolder()));
        if (!root) return { cancelled: true };
        const result = await this.engine.request('project.fromClipboard', { target: root }, { timeout: LONG });
        if (result.none) return result;
        await this.showNew(root, surface);
        return result;
    }

    // Images with no board to go into: a new project made of them (project.fromImages), after asking where.
    async projectFromImages({ files, raw, emptyMessage }, surface) {
        const first = files && files[0];
        const beside = surface.beside;
        const defaultPath = beside ? path.join(path.dirname(beside), `${path.basename(beside, path.extname(beside))}.comp`)
            : untitled(workspaceFolder());
        const root = await this.askLocation(defaultPath);
        if (!root) return { cancelled: true };
        if (!first) return { errors: emptyMessage || null };
        const result = await this.engine.request('project.fromImages', { target: root, files, raw: raw || {}, emptyMessage }, { timeout: LONG });
        await this.showNew(root, surface);
        return result;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Open, Open Recent, Close (file.md 4.4)

    async openProjects(uri, uris, surface) {
        let roots;
        if (uris && uris.length) roots = uris.map((u) => u.fsPath);
        else if (uri && uri.fsPath) roots = [uri.fsPath];
        else {
            const picked = await vscode.window.showOpenDialog({
                title: 'Open Project', openLabel: 'Open', canSelectFiles: true, canSelectFolders: true, canSelectMany: true,
                filters: { 'Compositor Project': ['comp'] },
            });
            if (!picked) return;
            roots = picked.map((u) => u.fsPath);
        }
        await this.openRoots(roots, surface);
    }

    // Each project is checked before anything opens (project.inspect: Compositor's own load and validation), so a broken
    // one shows "Couldn’t open the project" and opens no tab.
    async openRoots(paths, surface) {
        let opened = false;
        for (const target of paths) {
            let root;
            try { root = io.packageRoot(target); } catch { root = target; }
            try {
                await this.engine.request('project.inspect', { project: root }, { timeout: LONG });
            } catch (error) {
                if (!fs.existsSync(root)) forget(this.context, root);
                await modal('Couldn’t open the project', error.message);
                continue;
            }
            remember(this.context, root);
            if (surface && surface.place === 'sidebar') await this.provider.showInSidebar(root);
            else await this.provider.moveToEditor(root, surface && surface.panel ? surface.panel.viewColumn : undefined);
            opened = true;
        }
        // The blank New Canvas tab gives way to the project, as Compositor's blank start tab does.
        if (opened && surface && surface.panel) surface.panel.dispose();
    }

    async openRecent(surface) {
        const items = this.recentEntries().map((r) => ({ label: r.name, description: r.folder, root: r.root }));
        if (items.length) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(clear-all) Clear Menu', clear: true });
        const picked = await vscode.window.showQuickPick(items, { title: 'Open Recent', placeHolder: items.length ? 'Choose a project' : 'No recent projects' });
        if (!picked) return;
        if (picked.clear) await this.context.globalState.update(RECENT_KEY, []);
        else await this.openRoots([picked.root], surface);
    }

    async closeBoard(document) {
        if (!this.needBoard(document)) return;
        if (document.place === 'sidebar') await this.provider.sidebar.release();
        else await this.provider.closeEditorFor(document.root);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Save As (file.md 5.3)

    async saveAs(document) {
        if (!this.needBoard(document)) return;
        await this.provider.flush(document);
        const target = await vscode.window.showSaveDialog({
            title: 'Save Project As', defaultUri: vscode.Uri.file(document.root), filters: { 'Compositor Project': ['comp'] },
        });
        if (!target) return;
        let root = target.fsPath;
        if (!root.toLowerCase().endsWith('.comp')) root += '.comp';
        if (path.resolve(root) === path.resolve(document.root)) return;
        try {
            if (fs.existsSync(root)) {
                await this.closeBoardAt(root);
                fs.rmSync(root, { recursive: true, force: true });
            }
            // The copy keeps documentID, as Compositor's Save As does; the notes and layer-lock sidecars go along (port choice).
            fs.cpSync(document.root, root, { recursive: true });
            for (const sidecar of [io.notesPath, io.boardStatePath]) {
                if (fs.existsSync(sidecar(document.root))) fs.copyFileSync(sidecar(document.root), sidecar(root));
                else fs.rmSync(sidecar(root), { force: true });
            }
        } catch (error) {
            await modal('Couldn’t save the project', error.message);
            return;
        }
        remember(this.context, root);
        if (document.place === 'sidebar') await this.provider.showInSidebar(root);
        else {
            const column = this.columnOf(document.root);
            await this.helpers.openBoard(root, column);
            // Its last state is on disk already; saving clears VS Code's own dirty mark so the tab closes without asking.
            await vscode.workspace.save(document.uri).then(undefined, () => {});
            await this.provider.closeEditorFor(document.root);
        }
    }

    columnOf(root) {
        const target = this.helpers.manifestUri(root).toString();
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) if (tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === target) return group.viewColumn;
        }
        return undefined;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Import (file.md 6.6)

    async importTypes() {
        if (!this.types) this.types = await this.engine.request('import.types', {});
        return this.types;
    }

    // The picker, files and folders; the board then runs its sheets and imports. With no board, a New Canvas tab takes
    // the images and makes a project of them.
    async importImages(uri, uris, surface) {
        let paths;
        if (uris && uris.length) paths = uris.map((u) => u.fsPath);
        else if (uri && uri.fsPath) paths = [uri.fsPath];
        else {
            const types = await this.importTypes();
            const picked = await vscode.window.showOpenDialog({
                title: 'Import Images', openLabel: 'Import', canSelectFiles: true, canSelectFolders: true, canSelectMany: true,
                filters: { Images: [...types.extensions, ...types.raw] },
            });
            if (!picked) return;
            paths = picked.map((u) => u.fsPath);
        }
        if (surface && !surface.document) {
            surface.post({ type: 'importFiles', paths, point: null });
            return;
        }
        const document = (surface && surface.document) || this.currentBoard();
        if (document) document.post({ type: 'importFiles', paths, point: null });
        else this.newCanvas({ importPaths: paths });
    }

    // Explorer › New Board from Image: one project per image, beside it (ProjectWorkspace.swift:166-184).
    async newFromImages(uri, uris) {
        const paths = uris && uris.length ? uris.map((u) => u.fsPath) : uri && uri.fsPath ? [uri.fsPath] : [];
        for (const p of paths) this.newCanvas({ importPaths: [p], beside: p });
    }

    // A drop onto a board or the welcome view (file.md 14.5): Finder files arrive as bytes and are written to a private
    // folder under their own names; Explorer drops (Shift held) arrive as paths, and a .comp among them opens.
    async drop({ files = [], folders = [], uris = [], point = null, unreadable = false, packages = [] }, surface) {
        const paths = [], temp = [];
        const write = (name, bytes, dir) => {
            const file = path.join(dir, name || 'Dropped');
            fs.writeFileSync(file, Buffer.from(bytes));
            return file;
        };
        try {
            for (const f of files) {
                const dir = path.join(this.tempRoot(), crypto.randomUUID());
                fs.mkdirSync(dir, { recursive: true });
                temp.push(dir);
                paths.push(write(f.name, f.bytes, dir));
            }
            for (const folder of folders) {
                const dir = path.join(this.tempRoot(), crypto.randomUUID(), folder.name);
                fs.mkdirSync(dir, { recursive: true });
                temp.push(path.dirname(dir));
                for (const f of folder.files) write(f.name, f.bytes, dir);
                paths.push(dir);
            }
        } catch (error) {
            await modal('Import couldn’t finish', error.message);
            return;
        }
        const projects = [];
        for (const u of uris) {
            let file;
            try { file = vscode.Uri.parse(u).fsPath; } catch { continue; }
            if (/\.comp\/?$/i.test(file) || file.toLowerCase().endsWith('.comp/manifest.json')) projects.push(file);
            else paths.push(file);
        }
        if (projects.length) await this.openRoots(projects, surface.place === 'panel' ? surface : null);
        const errors = [];
        if (packages.length) errors.push('Open Compositor projects with Open Project….');
        if (unreadable) errors.push('Some dropped items couldn’t be read. Drag JPEG, PNG, HEIC, HEIF, TIFF, WebP, or Photoshop (PSD) files from Finder.');
        if (paths.length) surface.post({ type: 'importFiles', paths, point, temp, extraErrors: errors });
        else if (errors.length) await modal('Import couldn’t finish', errors.join('\n\n'));
    }

    tempRoot() {
        const root = path.join(os.tmpdir(), 'compositor-board-drops');
        fs.mkdirSync(root, { recursive: true });
        return root;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Export (file.md 9, 10.5)

    exportDefault(document, extension) {
        const folder = this.lastExportFolder || path.dirname(document.root);
        return vscode.Uri.file(path.join(folder, `${path.basename(document.root, '.comp')}.${extension}`));
    }

    // Export PNG…: straight to the save dialog, the flattened canvas written by Compositor's exporter; the project stays
    // as it is (no undo step, no dirty state).
    async exportPNG(document) {
        if (!this.needBoard(document)) return;
        await this.provider.flush(document);
        const target = await vscode.window.showSaveDialog({ title: 'Export PNG', defaultUri: this.exportDefault(document, 'png'), filters: { PNG: ['png'] } });
        if (!target) return;
        this.lastExportFolder = path.dirname(target.fsPath);
        try {
            await this.engine.request('export.png', { project: document.root, path: target.fsPath }, { timeout: LONG });
        } catch (error) {
            await modal('Couldn’t export PNG', error.message);
        }
    }

    // Export… in the Export As sheet: the save dialog "Export <FORMAT>", then the bytes the preview was made from.
    async exportSave({ token, format }, document) {
        const extension = EXTENSIONS[format] || 'png';
        const target = await vscode.window.showSaveDialog({
            title: `Export ${format}`, defaultUri: this.exportDefault(document, extension), filters: { [format]: [extension] },
        });
        if (!target) return { cancelled: true };
        this.lastExportFolder = path.dirname(target.fsPath);
        try {
            return await this.engine.request('export.write', { token, path: target.fsPath }, { timeout: LONG });
        } catch (error) {
            await modal('Couldn’t export', error.message);
            return { failed: true };
        }
    }

    // Export As › Load Profile…: a CMYK output profile copied in under its file name and chosen (CMYK.load), into the
    // folder View › CMYK keeps them in (chrome.md 12.6); a failure goes to the sheet's error slot.
    async loadProfile(surface) {
        const picked = await vscode.window.showOpenDialog({
            title: 'Choose a CMYK ICC profile, such as the one your printer gave you', canSelectMany: false,
            filters: { 'ICC Profile': ['icc', 'icm'] },
        });
        if (!picked || !picked[0]) return { cancelled: true };
        const file = picked[0].fsPath;
        try {
            const { name } = await this.engine.request('cmyk.validate', { path: file, folders: this.provider.cmykFolders() });
            const folder = this.provider.cmykFolders()[0];
            fs.mkdirSync(folder, { recursive: true });
            const target = path.join(folder, path.basename(file));
            fs.copyFileSync(file, `${target}.${process.pid}.tmp`);
            fs.renameSync(`${target}.${process.pid}.tmp`, target);
            await this.context.globalState.update(PREFERENCES_KEY, { ...(this.context.globalState.get(PREFERENCES_KEY) || {}), cmykProfile: name });
            // The board's View › CMYK › Profile follows, as session.proofProfile does in Compositor.
            if (surface && surface.post) surface.post({ type: 'cmykLoaded', name });
            return { name };
        } catch (error) {
            return { error: error.message };
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // QuickLook (file.md 12.2): every board write drops the package's QuickLook folder; once the board has been quiet
    // for a few seconds Compositor's own preview is written back, if the project is still the one it was made from.

    afterWrite(document) {
        clearTimeout(this.quickLookTimers.get(document.root));
        this.quickLookTimers.set(document.root, setTimeout(() => this.writeQuickLook(document), 3000));
    }

    async writeQuickLook(document) {
        if (document.disposed || document.missing || document.dirty || document.engineBusy) return;
        let before;
        try { before = io.hash(io.readManifestBytes(document.root)); } catch { return; }
        const out = this.engine.tempFile('jpg');
        try {
            const result = await this.engine.request('project.quickLook', { project: document.root, out }, { timeout: LONG });
            if (result.none || !fs.existsSync(out)) return;
            const bytes = fs.readFileSync(out);
            io.withLock(document.root, () => {
                if (io.hash(io.readManifestBytes(document.root)) !== before) return;
                fs.mkdirSync(path.join(document.root, 'QuickLook'), { recursive: true });
                io.writeAtomic(path.join(document.root, 'QuickLook', 'Preview.jpg'), bytes);
            });
        } catch (error) {
            console.error('[compositor-board] QuickLook preview failed', error);
        } finally {
            fs.rmSync(out, { force: true });
        }
    }
}

module.exports = { FileCommands, remember, recentList, RECENT_LIMIT };
