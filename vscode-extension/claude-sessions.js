'use strict';
// Send to Claude: a note goes from the board to a running Claude Code session as a cross-session message
// (code.claude.com/docs/en/cross-session-messaging). The sessions on offer are the ones running the board plugin,
// whose MCP server records them (core/bridge-protocol.js readSessions); a message is one JSON line written to the
// session's inbox socket. The session shows it as a message from another session and, when idle, starts a turn.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const bridge = require('./core/bridge-protocol');
const io = require('./core/package-io');
const noteTargets = require('./core/note-target');

const PLUGIN = 'compositor-board';
const TARGETS_KEY = 'compositorBoard.claudeTargets';

// Claude Code's own record of a session (~/.claude/sessions/<pid>.json): its name, whether it is busy, its transcript's
// session id and its inbox when the MCP server was not told it. Not a documented file, so every field is optional.
function claudeRecord(pid) {
    try {
        return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8'));
    } catch {
        return null;
    }
}

// Which process started which, read at most every 2 s: Claude Code's extension runs each chat as a child of the
// VS Code window's extension host, the process this extension runs in too, so a chat whose ancestors include this
// process is open in this window.
let parents = { at: 0, map: new Map() };

function inThisWindow(pid) {
    if (Date.now() - parents.at >= 2000) {
        const map = new Map();
        try {
            for (const line of execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 }).split('\n')) {
                const [child, parent] = line.trim().split(/\s+/).map(Number);
                if (child) map.set(child, parent);
            }
        } catch {
            // Not known: no chat counts as this window's.
        }
        parents = { at: Date.now(), map };
    }
    for (let p = parents.map.get(pid), hops = 0; p > 1 && hops < 8; p = parents.map.get(p), hops++) if (p === process.pid) return true;
    return false;
}

// The chat's title, as its Claude Code tab shows it: the name the person gave it (a custom-title line), else the one
// Claude Code wrote for it (ai-title). Claude Code appends these lines to the session's transcript again and again, so
// the end of the file has the latest; only what was added since the last look is read. Not a documented format either:
// a session without a title keeps its record's name.
const TITLE_CHUNK = 256 * 1024;
const TITLE_REACH = 8 * 1024 * 1024;
const titles = new Map(); // transcript -> { size, custom, ai }
const transcripts = new Map(); // session id -> transcript

function transcriptOf(record) {
    const id = record && record.sessionId;
    if (typeof id !== 'string' || !/^[0-9A-Za-z-]+$/.test(id)) return null;
    if (transcripts.has(id) && fs.existsSync(transcripts.get(id))) return transcripts.get(id);
    const projects = path.join(os.homedir(), '.claude', 'projects');
    const name = `${id}.jsonl`;
    // The folder is the session's working folder with every other character than a letter or digit made a dash; a
    // folder named some other way (a long path) is looked for.
    const guess = typeof record.cwd === 'string' ? path.join(projects, record.cwd.replace(/[^A-Za-z0-9]/g, '-'), name) : null;
    let found = guess && fs.existsSync(guess) ? guess : null;
    if (!found) {
        try {
            found = fs.readdirSync(projects).map((dir) => path.join(projects, dir, name)).find((file) => fs.existsSync(file)) || null;
        } catch {
            found = null;
        }
    }
    if (found) transcripts.set(id, found);
    return found;
}

// The latest custom and AI titles among the whole lines of `buffer`.
function titlesIn(buffer, into) {
    const text = buffer.toString('utf8');
    if (!text.includes('-title"')) return;
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0 && !(into.custom && into.ai); i--) {
        const kind = /"type"\s*:\s*"(custom|ai)-title"/.exec(lines[i]);
        if (!kind || into[kind[1]]) continue;
        try {
            const entry = JSON.parse(lines[i]);
            const title = kind[1] === 'custom' ? entry.customTitle : entry.aiTitle;
            if (typeof title === 'string' && title.trim()) into[kind[1]] = title.trim();
        } catch {
            // A line cut by the read, or still being written.
        }
    }
}

function chatTitle(record) {
    const file = transcriptOf(record);
    if (!file) return null;
    let size;
    try {
        size = fs.statSync(file).size;
    } catch {
        return null;
    }
    const known = titles.get(file);
    if (known && known.size === size) return known.custom || known.ai;
    // Back from the end, a chunk at a time, down to what was read before (or TITLE_REACH), stopping at the first chunk
    // that has a title. A line that starts before a chunk is finished with the next one.
    const floor = known && known.size < size ? known.size : Math.max(0, size - TITLE_REACH);
    const found = { custom: null, ai: null };
    let fd = null;
    try {
        fd = fs.openSync(file, 'r');
        let end = size, rest = Buffer.alloc(0);
        while (end > floor && !found.custom && !found.ai) {
            const start = Math.max(floor, end - TITLE_CHUNK);
            const chunk = Buffer.alloc(end - start);
            fs.readSync(fd, chunk, 0, chunk.length, start);
            const buffer = Buffer.concat([chunk, rest]);
            const first = start > floor ? buffer.indexOf(10) + 1 : 0;
            if (start > floor && first === 0) {
                rest = buffer;
            } else {
                rest = buffer.subarray(0, first);
                titlesIn(buffer.subarray(first), found);
            }
            end = start;
        }
    } catch {
        // Unreadable now: the title found before, if any, stays.
    } finally {
        if (fd !== null) fs.closeSync(fd);
    }
    const next = { size, custom: found.custom || (known && known.custom) || null, ai: found.ai || (known && known.ai) || null };
    titles.set(file, next);
    return next.custom || next.ai;
}

function isSocket(file) {
    try {
        return fs.statSync(file).isSocket();
    } catch {
        return false;
    }
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

function within(child, parent) {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function size(n) {
    return Math.round(n * 10) / 10;
}

// The message Claude reads: which board and note, the thread in order, where the change goes (the note's edit target,
// else the board's, else the person's workspace) and how to answer on the board.
function compose(root, note) {
    const r = note.rect || { x: 0, y: 0, width: 0, height: 0 };
    const where = r.width || r.height
        ? `a box at x ${size(r.x)}, y ${size(r.y)}, ${size(r.width)} x ${size(r.height)} px`
        : `a spot at x ${size(r.x)}, y ${size(r.y)}`;
    const thread = [{ author: note.author, text: note.text }, ...(note.replies || [])]
        .map((m) => `${m.author === 'claude' ? 'Claude' : 'Person'}: ${m.text}`).join('\n');
    return [
        `[Compositor Board] The person sent you note ${note.number} from their board in VS Code.`,
        `Project: ${root}`,
        `Note ${note.number} is pinned to ${where} (document pixels):`,
        '',
        thread,
        '',
        noteTargets.guidance(noteTargets.effective(root, note, io.readBoardState(root).noteTarget)),
        '',
        `Look at the board with read_board and view_board to see what the note points at, then make the change in the edit target. Answer in the note's thread with add_note (reply_to "${note.id}"), saying what you changed and where; call resolve_note when it is done.`,
    ].join('\n');
}

// One line into the inbox, in the shape Claude Code's inbox takes from a script, marked as coming from this plugin.
// The inbox does not answer: a session that holds or refuses messages (its crossSessionInbound setting) says so itself.
function deliver(socket, text) {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: text }, uuid: crypto.randomUUID(), from_plugin: PLUGIN }) + '\n';
    return new Promise((resolve, reject) => {
        const connection = net.createConnection(socket, () => connection.end(line));
        connection.setTimeout(5000, () => connection.destroy(new Error('The Claude session did not take the message in time.')));
        connection.on('error', (error) => {
            reject(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? new Error('That Claude session has ended.') : error);
        });
        connection.on('close', (hadError) => {
            if (!hadError) resolve();
        });
    });
}

class ClaudeSessions {
    // `memento` keeps, per board root, the session pinned in the board's Send to row ({ pid, procStart }), so the pin
    // outlives a window reload for as long as that session runs. `tabs()` gives the titles of the Claude Code chat tabs in this
    // window, { front, open }: the one in front (or last in front) and all of them.
    constructor(memento, tabs) {
        this.memento = memento || null;
        this.tabs = tabs || (() => ({ front: null, open: [] }));
        this.targets = new Map(Object.entries((this.memento && this.memento.get(TARGETS_KEY)) || {}));
    }

    // Live sessions for the board at `root`, the one Send to Claude uses first: the session pinned in the board, else
    // a chat of this VS Code window (`here`), the one whose tab is in front first, then the one whose tools last
    // touched this project, then one working in a folder that holds it (the deepest first), then the latest started;
    // chats of other windows come after, in the same order. `name` is the chat's title where there is one, which is
    // what its tab shows.
    list(root) {
        const front = this.tabs().front;
        const sessions = [];
        for (const info of bridge.readSessions()) {
            const record = claudeRecord(info.sessionPid);
            const socket = [info.socket, record && record.messagingSocketPath].find((s) => typeof s === 'string' && isSocket(s));
            if (!socket) continue;
            const cwd = String(info.cwd || '');
            const code = (record && typeof record.name === 'string' && record.name) || path.basename(cwd) || 'Claude session';
            sessions.push({
                id: info.sessionPid, socket, folder: cwd, code, here: inThisWindow(info.sessionPid),
                name: chatTitle(record) || code,
                procStart: record && record.procStart !== undefined ? String(record.procStart) : null,
                status: record && (record.status === 'busy' || record.status === 'idle') ? record.status : null,
                touched: (info.roots || []).includes(root) ? info.usedAt || 0 : 0,
                depth: cwd && within(root, cwd) ? cwd.length : -1,
                startedAt: info.startedAt || 0,
            });
        }
        const inFront = (s) => (s.here && front && s.name === front ? 1 : 0);
        sessions.sort((a, b) => b.here - a.here || inFront(b) - inFront(a) || b.touched - a.touched || b.depth - a.depth || b.startedAt - a.startedAt);
        const target = this.targets.get(root);
        const picked = target ? sessions.findIndex((s) => s.id === target.pid && (!target.procStart || s.procStart === target.procStart)) : -1;
        if (picked > 0) sessions.unshift(...sessions.splice(picked, 1));
        if (target && picked < 0 && !alive(target.pid)) this.pin(root, null);
        return sessions.map(({ id, name, code, here, folder, status, socket, startedAt }, i) => ({
            id, name, code, here, folder, status, socket, startedAt, target: i === 0, pinned: i === 0 && picked >= 0,
        }));
    }

    // The list as the board shows it, folders under the home folder written with ~.
    menu(root) {
        const home = os.homedir();
        return this.list(root).map(({ socket, folder, ...shown }) => ({
            ...shown, folder: within(folder, home) ? `~${folder.slice(home.length)}` : folder,
        }));
    }

    // The session `pid` (from list) is pinned as the board's: Send to Claude goes there until it ends. Null unpins, and
    // the chat tab in front leads again.
    pin(root, pid) {
        if (pid === null) {
            this.targets.delete(root);
        } else {
            if (!this.list(root).some((s) => s.id === pid)) throw new Error('That Claude session has ended.');
            const record = claudeRecord(pid);
            this.targets.set(root, { pid, procStart: record && record.procStart !== undefined ? String(record.procStart) : null });
        }
        if (this.memento) this.memento.update(TARGETS_KEY, Object.fromEntries(this.targets));
    }

    // Sends `note` ({ id, number, author, text, rect, replies, target }) to the session `to` (a pid from list), or to
    // the board's session.
    async send(root, note, to) {
        const sessions = this.list(root);
        const session = to === undefined ? sessions[0] : sessions.find((s) => s.id === to);
        if (!session) {
            throw new Error(to === undefined
                ? 'No Claude Code session with the Compositor Board plugin is running. Start one (restart a session that was already running when the plugin was installed or updated), then send again.'
                : 'That Claude session has ended.');
        }
        await deliver(session.socket, compose(root, note));
        return { id: session.id, name: session.name };
    }
}

module.exports = { ClaudeSessions, compose };
