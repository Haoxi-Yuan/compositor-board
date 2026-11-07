'use strict';
// Line icons for the board (drawn here, since SF Symbols may not ship outside Apple platforms), and Compositor's color
// picker (upstream UI/ColorPickerSheet.swift, Document/ColorPalette.swift): a saturation/brightness field, a hue strip
// with red at the top, RGB and hex fields, OK and Cancel. While it is open a click on the canvas samples into it.

(function () {
    const CB = (window.CB = window.CB || {});

    const PATHS = {
        move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
        brush: '<path d="M14.5 4.5l5 5-8.2 8.2a3 3 0 0 1-2.1.9H6.5v-2.7a3 3 0 0 1 .9-2.1z"/><path d="M12.5 6.5l5 5"/><path d="M6.5 18.6c-.8 1.2-2 1.9-3.5 1.9.3-1.6.8-2.8 1.8-3.6"/>',
        eraser: '<path d="M7.5 19.5l-4-4a2 2 0 0 1 0-2.8l9.2-9.2a2 2 0 0 1 2.8 0l5 5a2 2 0 0 1 0 2.8l-8 8.2z"/><path d="M7.5 19.5h12.5M9 9.5l6 6"/>',
        shapes: '<rect x="3.5" y="3.5" width="10" height="10" rx="1.5"/><circle cx="15.5" cy="15.5" r="5"/>',
        pipette: '<path d="M14.5 4.5a2.8 2.8 0 0 1 4 4l-2 2-4-4z"/><path d="M12.5 6.5l5 5M13.8 10.2l-7.6 7.6-2.7.7.7-2.7 7.6-7.6"/>',
        note: '<path d="M4.5 4.5h15v11l-4 4h-11z"/><path d="M15.5 19.5v-4h4M8 9h8M8 12.5h5"/>',
        hand: '<path d="M8 13V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v6.5"/><path d="M17 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1.2a6 6 0 0 1-4.3-1.8L4 15.7a1.5 1.5 0 0 1 2.2-2L8 15.5V13"/>',
        zoom: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5l5 5"/>',
        zoomIn: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5l5 5M10.5 7.5v6M7.5 10.5h6"/>',
        zoomOut: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5l5 5M7.5 10.5h6"/>',
        eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
        eyeOff: '<path d="M3 3l18 18M10.6 5.6A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.4 6.4C3.9 8.1 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9.4 9.4 0 0 0 5.2-1.6M9.9 9.9a2.8 2.8 0 0 0 4 4"/>',
        plusSquare: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M12 8v8M8 12h8"/>',
        trash: '<path d="M4 6.5h16M9.5 6.5V4.5h5v2M6.5 6.5l1 13h9l1-13M10 10.5v5.5M14 10.5v5.5"/>',
        pen: '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.6 7.6"/><circle cx="11" cy="11" r="2"/>',
        lock: '<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/>',
        unlock: '<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8.5 11V8a3.5 3.5 0 0 1 6.8-1.2"/>',
        swap: '<path d="M4 9h15l-4-4M20 15H5l4 4"/>',
        reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/>',
        layers: '<path d="M12 3.5l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
        folder: '<path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
        text: '<path d="M4 18L8.5 6h1L14 18M5.5 14h7M15.5 13.5a2.8 2.8 0 0 1 5 1.5V18M20.5 16.2c-1.8-.4-4.5-.2-4.5 1.2s2.6 1.6 4.5.3"/>',
        adjust: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>',
        chevronRight: '<path d="M9 5l7 7-7 7"/>',
        chevronDown: '<path d="M5 9l7 7 7-7"/>',
        external: '<path d="M14 4.5h5.5V10M19.5 4.5L11 13M17 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18.5v-10A1.5 1.5 0 0 1 5.5 7H10"/>',
        check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
        marquee: '<rect x="4" y="5" width="16" height="14" rx="1" stroke-dasharray="3 2.5"/>',
        ellipseMarquee: '<ellipse cx="12" cy="12" rx="8.5" ry="7" stroke-dasharray="3 2.5"/>',
        lasso: '<path d="M7 17.5c-2.6-1.3-3.7-3.6-2.8-6.2C5.6 7.3 10.6 5 15.2 6.2c4 1.1 5.6 4.3 3.6 7-1.7 2.4-5.9 3.4-9.6 2.6"/><path d="M8.7 15.8c-1.2 1.4-.8 3.4.9 3.8 1.3.3 2.3-.6 2-1.8-.3-1.2-1.9-1.6-3-.8L6.5 20"/>',
        polygonLasso: '<path d="M6 17L4 9l8-4 8 5-3 7-6-1"/><path d="M8.5 15.5c-1.2 1.4-.8 3.4.9 3.8 1.3.3 2.3-.6 2-1.8-.3-1.2-1.9-1.6-3-.8L6.3 19.8"/>',
        wand: '<path d="M4 20l10-10M14 10l2 2"/><path d="M15 3v3M18.5 5.5l-2 2M21 9h-3M18.5 12.5l-2-2M12 5.5l-1.5-1.5"/>',
        objectSelect: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5" stroke-dasharray="3 2.5"/><circle cx="12" cy="10" r="2.5"/><path d="M7.5 17c.8-2.4 2.5-3.6 4.5-3.6s3.7 1.2 4.5 3.6"/>',
        sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15"/>',
        window: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 8.5h17"/>',
        chevronUp: '<path d="M5 15l7-7 7 7"/>',
        menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
        maskThumb: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><rect x="7.5" y="8.5" width="9" height="7" rx="1" fill="currentColor"/>',
        close: '<path d="M6 6l12 12M18 6L6 18"/>',
        folderPlus: '<path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 11v6M9 14h6"/>',
        link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
        unlink: '<path d="M15.7 14l3-3a4 4 0 0 0-5.7-5.7l-1 1M8.3 10l-3 3a4 4 0 0 0 5.7 5.7l1-1M4 4l16 16"/>',
        reply: '<path d="M9.5 6.5L4 12l5.5 5.5M4 12h10a6 6 0 0 1 6 6v1"/>',
    };

    function icon(name) {
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;
    }

    // ---------------------------------------------------------------------------------------------------------------

    const SIZE = 256;

    function hsvToRgb(h, s, v) {
        const f = (n) => {
            const k = (n + h / 60) % 6;
            return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
        };
        return [f(5), f(3), f(1)];
    }

    // PickerHSB.setRGB (ColorPalette.swift:321-337): brightness from the brightest channel; the previous hue is kept for
    // grays and the previous saturation for black, so dragging through them never loses the color.
    function rgbToHsv([r, g, b], previous = { h: 0, s: 0 }) {
        const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
        const out = { h: previous.h, s: previous.s, v: max };
        if (max > 0) out.s = d / max;
        if (d > 0) {
            let h;
            if (max === r) h = (g - b) / d;
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
            out.h = h < 0 ? h + 360 : h;
        }
        return out;
    }

    const toByte = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
    const hex = (rgb) => rgb.map((v) => toByte(v).toString(16).padStart(2, '0')).join('').toUpperCase();
    // PaletteColor.quantized: each channel to the nearest 8-bit level (ColorPalette.swift:360).
    const quantized = (rgb) => rgb.map((v) => toByte(v) / 255);

    // "RRGGBB" or "RGB", with or without "#" (ColorPalette.swift:363-373).
    function parseHex(text) {
        let t = String(text).trim().replace(/^#/, '');
        if (/^[0-9a-f]{3}$/i.test(t)) t = t.split('').map((c) => c + c).join('');
        if (!/^[0-9a-f]{6}$/i.test(t)) return null;
        return [0, 2, 4].map((i) => parseInt(t.slice(i, i + 2), 16) / 255);
    }

    // The Color Picker panel (UI/ColorPickerSheet.swift): a movable floating panel titled by its target, first centered
    // on the canvas and afterwards where it was last left; its title bar's close button cancels. HSB is the working
    // state; what shows and what OK commits is the color quantized to 8 bits.
    class Picker {
        // host: the element the panel floats in.
        constructor(host) {
            this.host = host;
            this.element = null;
            this.position = null;
            this.options = null;
        }

        get isOpen() { return Boolean(this.element); }

        // A palette color (foreground, background) rather than a panel's or a dialog's.
        get palette() { return Boolean(this.element && this.options && this.options.palette); }

        // { title, color, onCommit(rgb), onChange(rgb), onCancel(), palette, dialog }: onChange follows every change of
        // the working color for targets that preview it live (text, effects, filter colors, dialogs; spec 7.2) and
        // onCancel puts their original back. A dialog target has no canvas sampling.
        open(options) {
            this.close(false);
            this.options = options;
            this.onCommit = options.onCommit;
            this.state = rgbToHsv(options.color);
            const el = document.createElement('div');
            el.className = 'picker';
            el.innerHTML = `
                <div class="bar"><button class="picker-close" title="Cancel" aria-label="Close"></button><span class="picker-title"></span></div>
                <div class="body">
                    <canvas class="field" width="${SIZE}" height="${SIZE}" style="width:${SIZE}px;height:${SIZE}px" role="img" aria-label="Saturation and brightness"></canvas>
                    <div class="hue-wrap" role="slider" aria-label="Hue"><canvas class="hue" width="20" height="${SIZE}" style="width:20px;height:${SIZE}px"></canvas><div class="hue-arrow"></div></div>
                    <div class="side">
                        <div class="top">
                            <div class="preview" role="img" aria-label="New color"></div>
                            <div class="ok-column"><button class="pill ok">OK</button><button class="pill cancel">Cancel</button></div>
                        </div>
                        <div class="fields">
                            <label class="caption" data-channel="0">R</label><input class="num" data-channel="0" aria-label="Red">
                            <label class="caption" data-channel="1">G</label><input class="num" data-channel="1" aria-label="Green">
                            <label class="caption" data-channel="2">B</label><input class="num" data-channel="2" aria-label="Blue">
                            <label>#</label><input class="num hex" aria-label="Hex color" spellcheck="false">
                        </div>
                        ${options.dialog ? '' : '<div class="caption-note">Click the canvas to sample</div>'}
                    </div>
                </div>`;
            el.querySelector('.picker-title').textContent = options.title;
            this.host.appendChild(el);
            this.element = el;
            const pos = this.position || {
                x: Math.max(8, (this.host.clientWidth - el.offsetWidth) / 2),
                y: Math.max(8, (this.host.clientHeight - el.offsetHeight) / 2),
            };
            el.style.left = `${pos.x}px`;
            el.style.top = `${pos.y}px`;
            this.field = el.querySelector('.field');
            this.hue = el.querySelector('.hue');
            this.drawHue();
            this.bindDrag(el.querySelector('.bar'));
            this.bindArea(this.field, (x, y) => { this.state.s = x; this.state.v = 1 - y; this.update(); });
            this.bindArea(this.hue, (x, y) => { this.state.h = (1 - y) * 360; this.update(); });
            const setChannel = (channel, value) => {
                const rgb = this.rgb();
                rgb[channel] = Math.min(255, Math.max(0, Math.round(value))) / 255;
                this.state = rgbToHsv(rgb, this.state);
                this.update();
            };
            el.querySelectorAll('input[data-channel]').forEach((input) => {
                input.addEventListener('change', () => {
                    const v = Number(input.value);
                    if (input.value.trim() === '' || !Number.isFinite(v)) { this.update(); return; }
                    setChannel(Number(input.dataset.channel), v);
                });
                input.addEventListener('keydown', (event) => this.fieldKey(event, input));
            });
            // The R, G and B labels scrub their channel, one level per point (ColorPickerSheet.swift:124-127).
            el.querySelectorAll('label[data-channel]').forEach((label) => label.addEventListener('pointerdown', (event) => {
                label.setPointerCapture(event.pointerId);
                const channel = Number(label.dataset.channel), start = event.clientX, from = toByte(this.rgb()[channel]);
                label.onpointermove = (e) => setChannel(channel, from + (e.clientX - start));
                label.onpointerup = () => { label.onpointermove = null; label.onpointerup = null; };
            }));
            const hexInput = el.querySelector('.hex');
            // Applied on Return or when the field loses focus; anything unreadable goes back to the color's hex.
            hexInput.addEventListener('change', () => {
                const rgb = parseHex(hexInput.value);
                if (rgb) this.state = rgbToHsv(rgb, this.state);
                hexInput.value = hex(this.rgb());
                this.update();
            });
            hexInput.addEventListener('keydown', (event) => this.fieldKey(event, hexInput));
            el.querySelector('.ok').addEventListener('click', () => this.close(true));
            el.querySelector('.cancel').addEventListener('click', () => this.close(false));
            el.querySelector('.picker-close').addEventListener('click', () => this.close(false));
            el.querySelector('.picker-close').addEventListener('pointerdown', (event) => event.stopPropagation());
            // OK and Cancel follow "Apply / Cancel current canvas operation" (configuredNativeShortcut).
            const isApply = (e) => (CB.Shortcuts ? CB.Shortcuts.isApply(e) : e.key === 'Enter');
            const isCancel = (e) => (CB.Shortcuts ? CB.Shortcuts.isCancel(e) : e.key === 'Escape');
            el.addEventListener('keydown', (event) => {
                if (isCancel(event)) { event.preventDefault(); event.stopPropagation(); this.close(false); }
                else if (isApply(event) && event.target.tagName !== 'INPUT') { event.preventDefault(); event.stopPropagation(); this.close(true); }
            });
            el.addEventListener('pointerdown', (event) => event.stopPropagation());
            this.update();
        }

        fieldKey(event, input) {
            event.stopPropagation();
            if (event.key === 'Enter') {
                input.dispatchEvent(new Event('change'));
                this.close(true);
                event.preventDefault();
            } else if (event.key === 'Escape') {
                this.close(false);
                event.preventDefault();
            } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && input.dataset.channel !== undefined) {
                const step = (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
                input.value = Math.min(255, Math.max(0, (Number(input.value) || 0) + step));
                input.dispatchEvent(new Event('change'));
                event.preventDefault();
            }
        }

        // The working color, quantized (ColorPickerState.color).
        rgb() {
            return quantized(hsvToRgb(((this.state.h % 360) + 360) % 360, this.state.s, this.state.v));
        }

        // A canvas sample while the picker is open goes into the working color, applied only on OK.
        sample(rgb) {
            if (!this.element) return;
            this.state = rgbToHsv(rgb, this.state);
            this.update();
        }

        update() {
            const rgb = this.rgb();
            const el = this.element;
            // A filter's color follows the working color live (FilterSheet onChange(of: colorPicker?.color)).
            if (this.options && this.options.onChange) this.options.onChange(rgb);
            el.querySelector('.preview').style.background = `#${hex(rgb)}`;
            el.querySelectorAll('input[data-channel]').forEach((input) => {
                if (document.activeElement !== input) input.value = toByte(rgb[Number(input.dataset.channel)]);
            });
            const hexInput = el.querySelector('.hex');
            if (document.activeElement !== hexInput) hexInput.value = hex(rgb);
            el.querySelector('.hue-arrow').style.top = `${(1 - this.state.h / 360) * SIZE}px`;
            el.querySelector('.hue-wrap').setAttribute('aria-valuetext', `${Math.round(this.state.h)} degrees`);
            this.drawField();
        }

        // White to the pure hue across, clear to black down; the marker a 12-point circle stroked white inside with a
        // black ring just outside (ColorPickerSheet.swift:52-72).
        drawField() {
            const ctx = this.field.getContext('2d');
            const pure = hsvToRgb(((this.state.h % 360) + 360) % 360, 1, 1).map(toByte);
            const across = ctx.createLinearGradient(0, 0, SIZE, 0);
            across.addColorStop(0, '#ffffff');
            across.addColorStop(1, `rgb(${pure.join(',')})`);
            ctx.fillStyle = across;
            ctx.fillRect(0, 0, SIZE, SIZE);
            const down = ctx.createLinearGradient(0, 0, 0, SIZE);
            down.addColorStop(0, 'rgba(0,0,0,0)');
            down.addColorStop(1, 'rgba(0,0,0,1)');
            ctx.fillStyle = down;
            ctx.fillRect(0, 0, SIZE, SIZE);
            const x = this.state.s * SIZE, y = (1 - this.state.v) * SIZE;
            ctx.beginPath();
            ctx.arc(x, y, 6.375, 0, Math.PI * 2);
            ctx.lineWidth = 0.75;
            ctx.strokeStyle = '#000000';
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x, y, 5.25, 0, Math.PI * 2);
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
        }

        // Hues 360, 300, ..., 0 from top to bottom: red, magenta, blue, cyan, green, yellow, red.
        drawHue() {
            const ctx = this.hue.getContext('2d');
            const g = ctx.createLinearGradient(0, 0, 0, SIZE);
            ['#ff0000', '#ff00ff', '#0000ff', '#00ffff', '#00ff00', '#ffff00', '#ff0000'].forEach((c, i) => g.addColorStop(i / 6, c));
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, 20, SIZE);
        }

        bindArea(canvas, apply) {
            canvas.addEventListener('pointerdown', (event) => {
                canvas.setPointerCapture(event.pointerId);
                const move = (e) => {
                    const r = canvas.getBoundingClientRect();
                    apply(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
                };
                move(event);
                canvas.onpointermove = move;
                canvas.onpointerup = () => { canvas.onpointermove = null; canvas.onpointerup = null; };
            });
        }

        bindDrag(bar) {
            bar.addEventListener('pointerdown', (event) => {
                bar.setPointerCapture(event.pointerId);
                const start = { x: event.clientX, y: event.clientY, left: this.element.offsetLeft, top: this.element.offsetTop };
                bar.onpointermove = (e) => {
                    this.element.style.left = `${start.left + e.clientX - start.x}px`;
                    this.element.style.top = `${start.top + e.clientY - start.y}px`;
                };
                bar.onpointerup = () => {
                    bar.onpointermove = null;
                    bar.onpointerup = null;
                    this.position = { x: this.element.offsetLeft, y: this.element.offsetTop };
                };
            });
        }

        close(commit) {
            if (!this.element) return;
            const rgb = this.rgb();
            this.position = { x: this.element.offsetLeft, y: this.element.offsetTop };
            this.element.remove();
            this.element = null;
            const onCommit = this.onCommit, onCancel = this.options && this.options.onCancel;
            this.options = null;
            this.onCommit = null;
            if (commit && onCommit) onCommit(rgb);
            // Cancel puts a filter's original color back (closeColorPicker(commit: false)).
            if (!commit && onCancel) onCancel();
        }
    }

    CB.icon = icon;
    // Tool modules add their rail icons here.
    CB.iconPaths = PATHS;
    CB.Color = { hsvToRgb, rgbToHsv, hex, parseHex, toByte, quantized };
    CB.Picker = Picker;
})();
