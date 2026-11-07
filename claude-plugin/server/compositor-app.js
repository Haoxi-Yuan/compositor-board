'use strict';
// The running Compositor app, seen from outside: it has no scripting interface, so this lists its windows through
// Core Graphics, captures one with `screencapture`, and saves through a ⌘S keystroke. Capturing needs the Screen
// Recording permission and the keystroke needs Accessibility, both granted to the app hosting Claude Code (VS Code or
// the terminal); every failure says which one is missing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const APP_PATH = '/Applications/Compositor.app';
const PROCESS_NAME = 'Compositor';

function run(command, args, { timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                error.stderr = String(stderr || '');
                reject(error);
            } else resolve(String(stdout));
        });
    });
}

// Every window of the app on any Space (option 0 = all windows), not only those on screen now.
const WINDOWS_SCRIPT = `
ObjC.import('CoreGraphics');
function run(argv) {
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0)));
  return JSON.stringify(list.filter(function (w) { return w.kCGWindowOwnerName === argv[0] && w.kCGWindowLayer === 0; })
    .map(function (w) { return { id: w.kCGWindowNumber, title: w.kCGWindowName || null, bounds: w.kCGWindowBounds, onScreen: Boolean(w.kCGWindowIsOnscreen) }; }));
}`;

async function isRunning() {
    try {
        await run('pgrep', ['-x', PROCESS_NAME]);
        return true;
    } catch {
        return false;
    }
}

// Document windows, front to back with the ones on screen first. Titles need the Screen Recording permission.
async function listWindows() {
    if (!(await isRunning())) return [];
    const out = await run('osascript', ['-l', 'JavaScript', '-e', WINDOWS_SCRIPT, PROCESS_NAME]);
    const windows = JSON.parse(out).filter((w) => w.bounds && w.bounds.Width > 200 && w.bounds.Height > 200);
    return [...windows.filter((w) => w.onScreen), ...windows.filter((w) => !w.onScreen)];
}

// Whether Compositor has this project open: while a project is open the app keeps its package directory and
// manifest open to watch them (upstream IO/ProjectWatcher.swift), so they show among the process's open files.
async function hasProjectOpen(root) {
    let pid;
    try { pid = (await run('pgrep', ['-x', PROCESS_NAME])).trim().split('\n')[0]; } catch { return false; }
    let real;
    try { real = fs.realpathSync(root); } catch { return false; }
    try {
        const out = await run('lsof', ['-p', pid, '-Fn']);
        return out.split('\n').some((line) => line === `n${real}` || line === `n${path.join(real, 'manifest.json')}`);
    } catch {
        return false;
    }
}

function notOpenError() {
    const error = new Error('This project is not open in the Compositor app (open it there with open_board, open_in "compositor").');
    error.code = 'ENOTOPEN';
    return error;
}

// The app macOS holds responsible for this process, which is the one that needs the permission.
function hostApp() {
    const term = process.env.TERM_PROGRAM || '';
    const bundle = process.env.__CFBundleIdentifier || '';
    if (term === 'vscode' || process.env.VSCODE_PID || bundle === 'com.microsoft.VSCode') return 'Visual Studio Code';
    if (term === 'Apple_Terminal' || bundle === 'com.apple.Terminal') return 'Terminal';
    if (term === 'iTerm.app' || bundle === 'com.googlecode.iterm2') return 'iTerm';
    if (bundle === 'com.anthropic.claudefordesktop') return 'Claude';
    return 'the app running Claude Code';
}

function permissionError(kind, detail) {
    const host = hostApp();
    const pane = kind === 'screen' ? 'Screen & System Audio Recording' : 'Accessibility';
    const error = new Error(`macOS blocked this: give ${host} the ${pane} permission in System Settings > Privacy & Security > ${pane}, then restart it. (${detail})`);
    error.code = kind === 'screen' ? 'ENOSCREENCAPTURE' : 'ENOACCESSIBILITY';
    return error;
}

// A PNG of the frontmost Compositor window (or the one whose title names the project), interface included.
async function captureWindow(root) {
    const projectName = path.basename(root, '.comp');
    if (!(await hasProjectOpen(root))) throw notOpenError();
    const windows = await listWindows();
    if (!windows.length) {
        const error = new Error(await isRunning() ? 'Compositor has no open window.' : 'Compositor is not running.');
        error.code = 'ENOWINDOW';
        throw error;
    }
    const named = projectName && windows.find((w) => w.title && w.title.includes(projectName));
    const target = named || windows[0];
    const file = path.join(os.tmpdir(), `compositor-window-${process.pid}-${Date.now()}.png`);
    try {
        await run('screencapture', ['-x', '-o', '-l', String(target.id), file]);
        return { png: fs.readFileSync(file), window: target, matchedTitle: Boolean(named) };
    } catch (error) {
        if (/could not create image/i.test(error.stderr + error.message)) throw permissionError('screen', 'screencapture could not read the window');
        throw error;
    } finally {
        fs.rmSync(file, { force: true });
    }
}

async function openInApp(root) {
    await run('open', ['-a', APP_PATH, root]);
}

const SAVE_SCRIPT = `
on run argv
  tell application "System Events" to set previous to name of first application process whose frontmost is true
  tell application "Compositor" to activate
  delay 0.25
  tell application "System Events" to keystroke "s" using command down
  delay 0.1
  if previous is not "Compositor" then
    tell application "System Events" to set frontmost of application process previous to true
  end if
end run`;

// Sends ⌘S to Compositor and waits for the project's QuickLook preview to be rewritten, which is the last thing the
// app's save writes. ⌘S saves the active tab only, so a timeout usually means another project is in front.
async function saveAndReadPreview(root, { timeout = 10000 } = {}) {
    if (!(await isRunning())) {
        const error = new Error('Compositor is not running.');
        error.code = 'ENOWINDOW';
        throw error;
    }
    if (!(await hasProjectOpen(root))) throw notOpenError();
    const preview = path.join(root, 'QuickLook', 'Preview.jpg');
    const started = Date.now();
    try {
        await run('osascript', ['-e', SAVE_SCRIPT], { timeout: 20000 });
    } catch (error) {
        const text = `${error.stderr} ${error.message}`;
        if (/not allowed|assistive|1002|-25211|-1719|-1743/i.test(text)) throw permissionError('accessibility', 'the ⌘S keystroke was refused');
        if (error.killed || /-1712|timed out/i.test(text)) {
            const timeout = new Error(`macOS is waiting for permission for ${hostApp()} to control System Events and Compositor: answer the dialog, or allow it in System Settings > Privacy & Security > Automation and Accessibility.`);
            timeout.code = 'EPERMISSIONPROMPT';
            throw timeout;
        }
        throw error;
    }
    while (Date.now() - started < timeout) {
        try {
            if (fs.statSync(preview).mtimeMs >= started - 50) {
                await new Promise((r) => setTimeout(r, 150));
                return fs.readFileSync(preview);
            }
        } catch { /* not written yet */ }
        await new Promise((r) => setTimeout(r, 120));
    }
    const error = new Error('Compositor did not save this project. Its active tab is probably another project, or the canvas is over 50 megapixels (no preview is written then).');
    error.code = 'ENOSAVE';
    throw error;
}

// Compositor's own flattened render from its last save, if that is newer than the manifest.
function savedPreview(root) {
    const preview = path.join(root, 'QuickLook', 'Preview.jpg');
    try {
        const stat = fs.statSync(preview);
        const manifest = fs.statSync(path.join(root, 'manifest.json'));
        return { jpg: fs.readFileSync(preview), savedAt: stat.mtime, fresh: stat.mtimeMs + 2000 >= manifest.mtimeMs };
    } catch {
        return null;
    }
}

module.exports = { APP_PATH, isRunning, listWindows, hasProjectOpen, captureWindow, openInApp, saveAndReadPreview, savedPreview };
