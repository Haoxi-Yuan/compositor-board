'use strict';
// The local bridge between the Compositor Board VS Code extension and the MCP server. Each VS Code window's
// extension host listens on 127.0.0.1 with a random port and token and records them in
// ~/.compositor-board/hosts/<pid>.json; the MCP server reads those files to ask an open board for its live canvas,
// including strokes not yet written to disk. The other way round, each MCP server records the Claude Code session
// that started it in ~/.compositor-board/sessions/<pid>.json, so a board can send a note to that session.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DIR = path.join(os.homedir(), '.compositor-board', 'hosts');
const SESSIONS_DIR = path.join(os.homedir(), '.compositor-board', 'sessions');
const VERSION = 1;

function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

function hostFile(pid) {
    return path.join(DIR, `${pid}.json`);
}

// The records in `dir` whose processes are still running (every pid named by `alive`). Files left by processes
// that died are removed.
function readLive(dir, alive) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const records = [];
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(dir, name);
        try {
            const info = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (info.version !== VERSION || !alive(info).every(processAlive)) {
                fs.rmSync(file, { force: true });
                continue;
            }
            records.push(info);
        } catch { /* half-written or foreign file */ }
    }
    return records;
}

function writeRecord(dir, info) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${info.pid}.json`);
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ version: VERSION, ...info }), { mode: 0o600 });
    fs.renameSync(temp, file);
}

// Live hosts, the most recently focused VS Code window first.
function readHosts() {
    return readLive(DIR, (info) => [info.pid]).sort((a, b) => (b.focusedAt || 0) - (a.focusedAt || 0));
}

function writeHost(info) {
    writeRecord(DIR, info);
}

function removeHost(pid) {
    fs.rmSync(hostFile(pid), { force: true });
}

// Claude Code sessions running the board's MCP server: { pid (the server), sessionPid, cwd, socket, startedAt,
// usedAt, roots (the projects its tools touched, latest first) }. A record lives while both processes do.
function readSessions() {
    return readLive(SESSIONS_DIR, (info) => [info.pid, info.sessionPid]);
}

function writeSession(info) {
    writeRecord(SESSIONS_DIR, info);
}

function removeSession(pid) {
    fs.rmSync(path.join(SESSIONS_DIR, `${pid}.json`), { force: true });
}

// One JSON request to one host. Resolves null if the host has gone away.
function request(host, method, route, body, { timeout = 15000 } = {}) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: host.port, method, path: route, timeout,
            headers: {
                authorization: `Bearer ${host.token}`,
                'content-type': 'application/json',
                ...(payload ? { 'content-length': payload.length } : {}),
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                let data;
                try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { data = null; }
                if (res.statusCode >= 400) {
                    const error = new Error((data && data.error) || `The VS Code board answered ${res.statusCode}`);
                    error.code = (data && data.code) || 'EBRIDGE';
                    reject(error);
                } else resolve(data);
            });
        });
        req.on('timeout', () => req.destroy(new Error('The VS Code board did not answer in time.')));
        req.on('error', (error) => (error.code === 'ECONNREFUSED' ? resolve(null) : reject(error)));
        if (payload) req.write(payload);
        req.end();
    });
}

// Every board open in any VS Code window, each tagged with the host that has it.
async function listBoards() {
    const boards = [];
    for (const host of readHosts()) {
        const answer = await request(host, 'GET', '/v1/boards').catch(() => null);
        for (const board of (answer && answer.boards) || []) boards.push({ ...board, host });
    }
    return boards;
}

// The host that has `root` open, or null.
async function hostFor(root) {
    const boards = await listBoards();
    const match = boards.find((b) => path.resolve(b.root) === path.resolve(root));
    return match ? match.host : null;
}

module.exports = { DIR, SESSIONS_DIR, VERSION, readHosts, writeHost, removeHost, readSessions, writeSession, removeSession, request, listBoards, hostFor };
