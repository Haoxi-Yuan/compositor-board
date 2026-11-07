'use strict';
// Talks to compositor-engine (engine/), the headless build of Compositor's own document code: one JSON request per
// line on its stdin, one answer per line on its stdout. Started on first use, restarted after a crash, and stopped
// after a while without requests. Images travel as files in a private temporary folder.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const IDLE_MS = 5 * 60 * 1000;

class EngineClient {
    // `binary`: path to compositor-engine.
    constructor(binary) {
        this.binary = binary;
        this.process = null;
        this.pending = new Map();
        this.nextID = 1;
        this.buffer = '';
        this.idleTimer = null;
        this.tempDir = null;
        // Edits the engine keeps open for a panel (a filter): it is not stopped for idleness while any is held.
        this.held = new Set();
    }

    hold(id) {
        if (id) this.held.add(id);
    }

    release(id) {
        this.held.delete(id);
        this.armIdle();
    }

    available() {
        return fs.existsSync(this.binary);
    }

    start() {
        if (this.process) return;
        if (!this.available()) {
            const error = new Error(`compositor-engine is missing at ${this.binary}; run engine/build.sh.`);
            error.code = 'ENOENGINE';
            throw error;
        }
        // A .vsix does not keep the executable bit.
        try { fs.accessSync(this.binary, fs.constants.X_OK); } catch { fs.chmodSync(this.binary, 0o755); }
        const child = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.process = child;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => this.receive(chunk));
        child.stderr.on('data', (chunk) => process.stderr.write(`[compositor-engine] ${chunk}`));
        child.on('exit', (code, signal) => {
            if (this.process !== child) return;
            this.process = null;
            this.buffer = '';
            this.held.clear();
            const error = new Error(`compositor-engine stopped (${signal || code}).`);
            for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
            this.pending.clear();
        });
    }

    receive(chunk) {
        this.buffer += chunk;
        let newline;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            let answer;
            try { answer = JSON.parse(line); } catch { continue; }
            const pending = this.pending.get(answer.id);
            if (!pending) continue;
            this.pending.delete(answer.id);
            clearTimeout(pending.timer);
            if (answer.ok) pending.resolve(answer.result);
            else {
                const error = new Error(answer.error || 'compositor-engine failed.');
                error.code = 'EENGINE';
                pending.reject(error);
            }
        }
        this.armIdle();
    }

    armIdle() {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            if (!this.pending.size && !this.held.size) this.stop();
        }, IDLE_MS);
        if (this.idleTimer.unref) this.idleTimer.unref();
    }

    request(op, args = {}, { timeout = 120000 } = {}) {
        this.start();
        const id = this.nextID++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`compositor-engine did not finish ${op} in time.`));
            }, timeout);
            this.pending.set(id, { resolve, reject, timer });
            this.process.stdin.write(JSON.stringify({ id, op, args }) + '\n');
            this.armIdle();
        });
    }

    // A fresh file path in the client's private temporary folder.
    tempFile(extension) {
        if (!this.tempDir) this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compositor-engine-'));
        return path.join(this.tempDir, `${crypto.randomUUID()}.${extension}`);
    }

    stop() {
        clearTimeout(this.idleTimer);
        if (this.process) {
            const child = this.process;
            this.process = null;
            child.stdin.end();
            child.kill();
        }
        if (this.tempDir) {
            fs.rmSync(this.tempDir, { recursive: true, force: true });
            this.tempDir = null;
        }
    }
}

module.exports = { EngineClient };
