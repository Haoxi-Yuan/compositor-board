'use strict';
// The board's menu bar, standing in for Compositor's macOS menus (upstream CompositorApp.swift). A menu is
// { title, items }, an item { label, def?, shortcut?, enabled?(), checked?(), run(), submenu? } or null for a separator;
// `def` names its keyboard shortcut definition (media/shortcuts.js), whose current chord is shown; `shortcut` is a
// literal for items without one. Wide boards show the titles in a row; compact ones a single button with the menus as
// submenus.

(function () {
    const CB = (window.CB = window.CB || {});

    const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    class MenuBar {
        constructor(board, element) {
            this.board = board;
            this.element = element;
            this.open = null;
            element.addEventListener('pointerdown', (e) => e.stopPropagation());
            window.addEventListener('pointerdown', () => this.close());
        }

        render() {
            const menus = this.board.menus();
            this.menus = menus;
            this.element.innerHTML = `<button class="menu-title compact-only" data-index="all" title="Menus">${CB.icon('menu')}</button>`
                + menus.map((m, i) => `<button class="menu-title wide-only" data-index="${i}">${escape(m.title)}</button>`).join('');
            this.element.querySelectorAll('.menu-title').forEach((b) => {
                b.addEventListener('click', () => {
                    if (this.open === b.dataset.index) this.close();
                    else this.show(b);
                });
                b.addEventListener('pointerenter', () => { if (this.open !== null && this.open !== b.dataset.index && b.dataset.index !== 'all') this.show(b); });
            });
        }

        show(button) {
            this.close();
            const index = button.dataset.index;
            const menus = index === 'all' ? this.menus.map((m) => ({ label: m.title, submenu: m.items })) : this.menus[Number(index)].items;
            const box = button.getBoundingClientRect();
            this.dropdown = this.list(menus, box.left, box.bottom);
            this.open = index;
            button.classList.add('on');
        }

        list(items, x, y) {
            const el = document.createElement('div');
            el.className = 'menu dropdown';
            for (const item of items) {
                if (!item) { el.appendChild(document.createElement('hr')); continue; }
                const b = document.createElement('button');
                const enabled = item.submenu ? true : item.enabled ? item.enabled() : true;
                b.disabled = !enabled;
                b.innerHTML = `<span class="check">${item.checked && item.checked() ? '✓' : ''}</span><span class="label">${escape(typeof item.label === 'function' ? item.label() : item.label)}</span>`
                    + `<span class="shortcut">${item.submenu ? '›' : escape(item.def && CB.Shortcuts ? CB.Shortcuts.labelFor(item.def) : item.shortcut || '')}</span>`;
                if (item.submenu) {
                    b.addEventListener('pointerenter', () => {
                        if (this.submenu) this.submenu.remove();
                        const r = b.getBoundingClientRect();
                        this.submenu = this.list(item.submenu, r.right - 4, r.top - 4);
                    });
                } else {
                    // Pointing at a plain item of the top list folds an open submenu away.
                    b.addEventListener('pointerenter', () => {
                        if (this.submenu && el === this.dropdown) { this.submenu.remove(); this.submenu = null; }
                    });
                    b.addEventListener('click', () => {
                        this.close();
                        item.run();
                    });
                }
                el.appendChild(b);
            }
            el.addEventListener('pointerdown', (e) => e.stopPropagation());
            document.body.appendChild(el);
            el.style.left = `${Math.max(2, Math.min(x, window.innerWidth - el.offsetWidth - 2))}px`;
            el.style.top = `${Math.max(2, Math.min(y, window.innerHeight - el.offsetHeight - 2))}px`;
            return el;
        }

        close() {
            if (this.dropdown) this.dropdown.remove();
            if (this.submenu) this.submenu.remove();
            this.dropdown = this.submenu = null;
            this.open = null;
            this.element.querySelectorAll('.menu-title.on').forEach((b) => b.classList.remove('on'));
        }
    }

    CB.MenuBar = MenuBar;
})();
