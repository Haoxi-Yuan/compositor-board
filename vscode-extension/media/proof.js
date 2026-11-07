'use strict';
// CMYK proofing on the canvas (docs/port-specs/chrome.md 12): the picture over white paper through one of the three
// 33³ lookups compositor-engine makes with ColorSync (proof, warning, marked), interpolated trilinearly as Core Image's
// CIColorCubeWithColorSpace does in sRGB (Rendering/EditorCanvas.swift:2762-2771). WebGL2 when there is one, the same
// lookup on the CPU otherwise. Also the View › CMYK menu, its state and the badges at the foot of the canvas, mixed into
// the Board.

(function () {
    const CB = (window.CB = window.CB || {});
    const N = 33;

    const VERTEX = `#version 300 es
        in vec2 position; out vec2 uv;
        void main() { uv = position * 0.5 + 0.5; uv.y = 1.0 - uv.y; gl_Position = vec4(position, 0.0, 1.0); }`;
    const FRAGMENT = `#version 300 es
        precision highp float; precision highp sampler3D;
        uniform sampler2D picture; uniform sampler3D cube; in vec2 uv; out vec4 color;
        void main() {
            vec3 c = texture(picture, uv).rgb;
            color = vec4(texture(cube, c * (32.0 / 33.0) + 0.5 / 33.0).rgb, 1.0);
        }`;

    class ProofPass {
        constructor() {
            this.canvas = new OffscreenCanvas(1, 1);
            const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
            this.gl = gl;
            this.cubes = new Map();
            if (!gl) return;
            const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); return s; };
            const program = gl.createProgram();
            gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
            gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { this.gl = null; return; }
            this.program = program;
            const buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
            const at = gl.getAttribLocation(program, 'position');
            gl.enableVertexAttribArray(at);
            gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
            this.picture = gl.createTexture();
        }

        cube(table) {
            const gl = this.gl;
            if (this.cubes.has(table)) return this.cubes.get(table);
            const texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_3D, texture);
            // Width = red, height = green, depth = blue: the lookups' red-fastest order.
            gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, N, N, N, 0, gl.RGBA, gl.FLOAT, table);
            for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR);
            for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
            this.cubes.set(table, texture);
            return texture;
        }

        // `source`: an opaque picture (already over white); returns a canvas of the same size through `table`.
        apply(source, table) {
            const gl = this.gl;
            if (!gl) return cpuApply(source, table);
            const w = source.width, h = source.height;
            if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
            gl.viewport(0, 0, w, h);
            gl.useProgram(this.program);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.picture);
            // sRGB values reach the shader unchanged.
            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
            for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
            for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
            gl.uniform1i(gl.getUniformLocation(this.program, 'picture'), 0);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_3D, this.cube(table));
            gl.uniform1i(gl.getUniformLocation(this.program, 'cube'), 1);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            return this.canvas;
        }
    }

    // The same trilinear lookup without WebGL2.
    function cpuApply(source, table) {
        const w = source.width, h = source.height;
        const out = new OffscreenCanvas(w, h), ctx = out.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(source, 0, 0);
        const image = ctx.getImageData(0, 0, w, h), d = image.data;
        const at = (r, g, b, c) => table[(((b * N + g) * N + r) * 4) + c];
        for (let i = 0; i < d.length; i += 4) {
            const fr = (d[i] / 255) * (N - 1), fg = (d[i + 1] / 255) * (N - 1), fb = (d[i + 2] / 255) * (N - 1);
            const r0 = Math.min(N - 2, Math.floor(fr)), g0 = Math.min(N - 2, Math.floor(fg)), b0 = Math.min(N - 2, Math.floor(fb));
            const tr = fr - r0, tg = fg - g0, tb = fb - b0;
            for (let c = 0; c < 3; c++) {
                const l = (r, g, b) => at(r, g, b, c);
                const x00 = l(r0, g0, b0) + (l(r0 + 1, g0, b0) - l(r0, g0, b0)) * tr, x10 = l(r0, g0 + 1, b0) + (l(r0 + 1, g0 + 1, b0) - l(r0, g0 + 1, b0)) * tr;
                const x01 = l(r0, g0, b0 + 1) + (l(r0 + 1, g0, b0 + 1) - l(r0, g0, b0 + 1)) * tr, x11 = l(r0, g0 + 1, b0 + 1) + (l(r0 + 1, g0 + 1, b0 + 1) - l(r0, g0 + 1, b0 + 1)) * tr;
                const y0 = x00 + (x10 - x00) * tg, y1 = x01 + (x11 - x01) * tg;
                d[i + c] = Math.round((y0 + (y1 - y0) * tb) * 255);
            }
            d[i + 3] = 255;
        }
        ctx.putImageData(image, 0, 0);
        return out;
    }

    const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    // The badges' icons (SF printer and exclamationmark.triangle).
    if (CB.iconPaths) {
        CB.iconPaths.printer = '<path d="M7 9V4.5h10V9"/><rect x="3.5" y="9" width="17" height="7.5" rx="1.5"/><path d="M7 14h10v6H7z"/>';
        CB.iconPaths.warningTriangle = '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.2v.3"/>';
    }

    const Proofing = {
        initProofing() {
            // Session state, never saved (EditorSession.swift:281-287).
            this.proofsColors = false;
            this.showsGamutWarning = false;
            this.proofProfile = null;
            this.cmykProfiles = null;
            this.proofTables = new Map();
            this.proofPass = null;
        },

        // CMYK.installed through the engine (system folders, the extension's loaded profiles, the app's own).
        async loadCMYKProfiles() {
            try {
                const result = await this.engine('cmyk.profiles', {}, { stateless: true });
                this.cmykProfiles = result.profiles || [];
            } catch (error) {
                this.cmykProfiles = [];
            }
            this.menuBar.render();
            return this.cmykProfiles;
        },

        // CMYK.chosen: the stored name, else Generic CMYK Profile, else the first installed.
        chosenProfile() {
            const all = this.cmykProfiles || [];
            return all.find((p) => p.name === this.prefs.cmykProfile) || all.find((p) => p.name === 'Generic CMYK Profile') || all[0] || null;
        },

        async setProof(kind, on) {
            if (on && !this.proofProfile) {
                if (!this.cmykProfiles) await this.loadCMYKProfiles();
                this.proofProfile = this.chosenProfile();
            }
            if (kind === 'proof') this.proofsColors = on;
            else this.showsGamutWarning = on;
            await this.ensureProofTables();
            this.renderProofBadges();
            this.view.draw();
            this.menuBar.render();
        },

        chooseProofProfile(profile) {
            this.proofProfile = profile;
            // proofProfile didSet: CMYK.chosen = proofProfile.
            this.setPref('cmykProfile', profile.name);
            this.ensureProofTables().then(() => { this.renderProofBadges(); this.view.draw(); });
            this.menuBar.render();
        },

        async ensureProofTables() {
            const profile = this.proofProfile;
            if (!profile || this.proofTables.has(profile.path) || !(this.proofsColors || this.showsGamutWarning)) return;
            try {
                const result = await this.engine('cmyk.lookups', { path: profile.path, name: profile.name }, { stateless: true, files: { out: 'bin' } });
                const bytes = result.files.out;
                const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
                const per = N * N * N * 4;
                this.proofTables.set(profile.path, { proof: floats.slice(0, per), warning: floats.slice(per, 2 * per), marked: floats.slice(2 * per, 3 * per) });
            } catch (error) {
                this.alert('Couldn’t proof', error.message);
                this.proofsColors = this.showsGamutWarning = false;
            }
        },

        // The lookup the canvas goes through now, or null.
        proofTable() {
            if (!(this.proofsColors || this.showsGamutWarning) || !this.proofProfile) return null;
            const tables = this.proofTables.get(this.proofProfile.path);
            if (!tables) return null;
            return this.proofsColors ? (this.showsGamutWarning ? tables.warning : tables.proof) : tables.marked;
        },

        // The document's visible part, drawn by the canvas over white, through the lookup.
        applyProof(picture) {
            const table = this.proofTable();
            if (!table) return picture;
            this.proofPass = this.proofPass || new ProofPass();
            return this.proofPass.apply(picture, table);
        },

        // View › CMYK (CompositorApp.swift:141-161).
        proofMenuItems() {
            const doc = () => Boolean(this.doc.manifest);
            const current = this.proofProfile || this.chosenProfile();
            const profiles = (this.cmykProfiles || []).map((p) => ({
                label: p.name, enabled: () => true, checked: () => Boolean(current && current.name === p.name), run: () => this.chooseProofProfile(p),
            }));
            return { label: 'CMYK', submenu: [
                { label: 'Proof Colors', def: 'CMYK Proof Colors', enabled: doc, checked: () => this.proofsColors, run: () => this.setProof('proof', !this.proofsColors) },
                { label: 'Gamut Warning', def: 'CMYK Gamut Warning', enabled: doc, checked: () => this.showsGamutWarning, run: () => this.setProof('warning', !this.showsGamutWarning) },
                null,
                { label: 'Profile', submenu: [...profiles, null, { label: 'Load Profile…', enabled: () => true, run: () => this.postMessage({ type: 'loadCMYKProfile' }) }] },
            ] };
        },

        // A profile picked with Load Profile… arrived (copied by the extension): it is chosen.
        async cmykProfileLoaded(name) {
            await this.loadCMYKProfiles();
            const profile = (this.cmykProfiles || []).find((p) => p.name === name);
            if (profile) this.chooseProofProfile(profile);
        },

        // The pills at the foot of the canvas (ContentView.swift:104-113): proof, gamut warning, then the mask's.
        renderProofBadges() {
            const host = this.badgesEl;
            if (!host) return;
            const pill = (kind, on, title, icon, help, label, close) => {
                let el = host.querySelector(`.canvas-pill.${kind}`);
                if (!on || !this.doc.manifest) { if (el) el.remove(); return; }
                if (!el) {
                    el = document.createElement('div');
                    el.className = `canvas-pill ${kind}`;
                    el.innerHTML = `${CB.icon(icon)}<b>${escape(title)}</b><span class="pill-name"></span><button class="pill-close" title="${escape(help)}" aria-label="${escape(label)}">${CB.icon('close')}</button>`;
                    el.querySelector('.pill-close').addEventListener('click', close);
                    el.addEventListener('pointerdown', (e) => e.stopPropagation());
                    host.insertBefore(el, kind === 'proof' ? host.firstChild : host.querySelector('.canvas-pill:not(.proof)'));
                }
                el.querySelector('.pill-name').textContent = this.proofProfile ? this.proofProfile.name : '';
            };
            pill('proof', this.proofsColors, 'CMYK Proof', 'printer', "Show the document's own colors again", 'Stop proofing', () => this.setProof('proof', false));
            pill('gamut', this.showsGamutWarning, 'CMYK Gamut Warning', 'warningTriangle', "Stop marking colors the profile can't print", 'Hide the gamut warning', () => this.setProof('warning', false));
        },
    };

    CB.Proofing = Proofing;
    CB.ProofPass = ProofPass;
})();
