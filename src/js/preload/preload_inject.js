const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
    const isLabs = window.location.hostname.includes('labs.perplexity.ai');
    const isMain = window.location.hostname.includes('perplexity.ai') && !isLabs;

    const mainSelectors = [
        'div.items-stretch.md\\:items-center.fill-mode-both.fixed.bottom-0.left-0.right-0.top-0.bg-backdrop\\/70.backdrop-blur-sm.animate-in.fade-in.ease-outExpo.duration-200',
        'div.max-w-\\[400px\\].overflow-hidden.rounded-xl.md\\:flex.md\\:max-w-\\[960px\\].border-borderMain\\/50',
        'relative.flex.flex-col.p-lg.md\\:w-\\[45\\%\\].md\\:p-xl',
        'md\\:h-\\[55\\%\\].md\\:w-\\[55\\%\\]',
        'rounded-lg.p-md.duration-300.ease-out.animate-in.fade-in.\\!p-lg.border-borderMain\\/50.ring-borderMain\\/50.divide-borderMain\\/50.dark\\:divide-borderMainDark\\/50.dark\\:ring-borderMainDark\\/50.dark\\:border-borderMainDark\\/50.bg-offset.dark\\:bg-offsetDark',
        
    ];

    const labsSelectors = [
        'div.flex.items-center.gap-sm'
    ];


    // Perplexity keeps Discover, Finance, Personal CFO, Health, Academic and
    // Patents behind the top-right menu, two clicks away. A user can promote
    // any of them into its left sidebar from Settings; nothing is added unless
    // they ask for it, so the default install leaves Perplexity's UI alone.
    //
    // The menu entries do not exist in the DOM until that menu is opened, so
    // they cannot be moved -- each one is rebuilt by cloning a real sidebar
    // row, which inherits Perplexity's markup, spacing and theming. Icons come
    // from their own sprite.
    const AVAILABLE_SHORTCUTS = [
        { id: 'discover', label: 'Discover',     path: '/discover', icon: 'pplx-icon-compass' },
        { id: 'finance',  label: 'Finance',      path: '/finance',  icon: 'pplx-icon-chart-area-line' },
        { id: 'cfo',      label: 'Personal CFO', path: '/cfo',      icon: 'pplx-icon-wallet' },
        { id: 'health',   label: 'Health',       path: '/health',   icon: 'pplx-icon-heart' },
        { id: 'academic', label: 'Academic',     path: '/academic', icon: 'pplx-icon-school' },
        { id: 'patents',  label: 'Patents',      path: '/patents',  icon: 'pplx-icon-gavel' },
    ];

    const INJECTED_ATTR = 'data-simplexity-shortcut';
    let enabledIds = [];
    let injecting = false;

    function setLabel(clone, text) {
        // The label is the truncating text node in the cloned row. Matching on
        // the class is far more reliable than walking for "the last leaf with
        // text", which picked the wrong node and left every row reading "New".
        const el = clone.querySelector('[class*="truncate"]')
            || [...clone.querySelectorAll('div, span')]
                .reverse()
                .find((d) => d.children.length === 0 && d.textContent.trim().length > 0);
        if (el) el.textContent = text;
        return !!el;
    }

    function syncSidebarLinks() {
        if (injecting) return;

        const nav = document.querySelector('nav[class*="group/sidebar"]');
        if (!nav) return;

        injecting = true;
        try {
            // Drop anything the user has since unticked.
            nav.querySelectorAll('[' + INJECTED_ATTR + ']').forEach((el) => {
                if (!enabledIds.includes(el.getAttribute(INJECTED_ATTR))) el.remove();
            });

            const wanted = AVAILABLE_SHORTCUTS.filter((s) => enabledIds.includes(s.id));
            if (!wanted.length) return;

            // Never clone one of our own rows, or the edits compound.
            const templateAnchor = [...nav.querySelectorAll('a[href^="/"][class*="absolute"]')]
                .find((a) => !a.closest('[' + INJECTED_ATTR + ']'));
            if (!templateAnchor) return;

            const template = templateAnchor.closest('[class*="collapsible-sidebar-section"]');
            if (!template || !template.parentElement) return;

            let after = template;
            const existing = nav.querySelectorAll('[' + INJECTED_ATTR + ']');
            if (existing.length) after = existing[existing.length - 1];

            for (const link of wanted) {
                if (nav.querySelector('[' + INJECTED_ATTR + '="' + link.id + '"]')) continue;

                const clone = template.cloneNode(true);
                clone.setAttribute(INJECTED_ATTR, link.id);

                const anchor = clone.querySelector('a[href]');
                if (!anchor) continue;
                anchor.setAttribute('href', link.path);
                anchor.setAttribute('aria-label', link.label);

                const use = clone.querySelector('svg use');
                if (use) {
                    use.setAttribute('xlink:href', '#' + link.icon);
                    use.setAttribute('href', '#' + link.icon);
                }

                // If the label cannot be set the row would read as a copy of
                // whatever was cloned, which is worse than not adding it.
                if (!setLabel(clone, link.label)) continue;

                after.parentElement.insertBefore(clone, after.nextSibling);
                after = clone;
            }
        } finally {
            injecting = false;
        }
    }

    // querySelectorAll throws a SyntaxError on a malformed selector, and this
    // runs inside a DOMContentLoaded listener, so one bad entry took the whole
    // script down with it -- including the MutationObserver registration below.
    // That is why nag screens were never actually being removed. Isolate each
    // selector so a future typo degrades instead of disabling everything.
    function removeNagScreens(selectors) {
        selectors.forEach((selector) => {
            try {
                document.querySelectorAll(selector).forEach((el) => {
                    el.remove();
                });
            } catch (err) {
                console.warn('[simplexity] skipping invalid nag-screen selector:', selector, err.message);
            }
        });
    }

    if (isLabs) {
        removeNagScreens(labsSelectors);
    } else if (isMain) {
        removeNagScreens(mainSelectors);
        syncSidebarLinks();
    }


    const observer = new MutationObserver(() => {
        if (isLabs) {
            removeNagScreens(labsSelectors);
        } else if (isMain) {
            removeNagScreens(mainSelectors);
            syncSidebarLinks();
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    ipcRenderer.invoke('get-sidebar-shortcuts').then((ids) => {
        enabledIds = Array.isArray(ids) ? ids : [];
        syncSidebarLinks();
    }).catch(() => {});

    if (isMain) {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
        const label = (el) => (el?.getAttribute('aria-label') || el?.getAttribute('title') || el?.innerText || '').replace(/\s+/g, ' ').trim();
        const controls = (root = document) => [...root.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="switch"]')].filter(visible);
        const menus = () => [...document.querySelectorAll('[role="menu"], [data-radix-menu-content]')].filter(visible);
        const modelKey = (value) => String(value).toLowerCase().replace(/\b(?:thinking|max)\b/g, '').replace(/[^a-z0-9]/g, '');
        const checked = (el) => {
            if (!el) return null;
            const value = String(el.getAttribute('aria-checked') || el.getAttribute('data-state') || '').toLowerCase();
            return ['true', 'checked', 'on', 'selected'].includes(value) ? true : ['false', 'unchecked', 'off'].includes(value) ? false : null;
        };
        const editor = () => [...document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], .ProseMirror[contenteditable="true"], [contenteditable="true"][data-placeholder]')]
            .find((el) => visible(el) && !el.disabled && !/search (?:sessions|connectors)/i.test(el.getAttribute('placeholder') || '')) || null;
        const modelControl = () => {
            const input = editor();
            const area = input?.closest('form') || input?.parentElement?.parentElement?.parentElement;
            return controls(area || document).find((el) =>
                /^Model$/i.test(label(el)) || /\b(?:GLM|GPT|Gemini|Claude|Grok|Kimi|Nemotron|Best)(?=\d|[\s-]|$)/i.test(label(el))) || null;
        };
        const closeMenus = () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', bubbles: true}));
        const clickMenu = (el) => {
            const event = {bubbles: true, button: 0, pointerType: 'mouse', isPrimary: true};
            el.dispatchEvent(new PointerEvent('pointerdown', event));
            el.dispatchEvent(new PointerEvent('pointerup', event));
            el.click();
        };
        const waitFor = async (read, ms = 4000) => {
            const until = Date.now() + ms;
            while (Date.now() < until) {
                const value = read();
                if (value) return value;
                await sleep(100);
            }
            return null;
        };

        const defaultPolicy = {model: 'glm-5.3', thinking: true};
        let preferred = {...defaultPolicy};
        let preferenceReady = false;
        let enforcing = false;
        let userMenuUntil = 0;
        let debounce = null;

        function scheduleModelPolicy() {
            clearTimeout(debounce);
            debounce = setTimeout(enforceModelPolicy, 120);
        }

        async function enforceModelPolicy() {
            if (enforcing || !preferenceReady || Date.now() < userMenuUntil) return;
            const wanted = preferred.model === 'gemini-3.8-flash' ? 'gemini-3.8-flash' : 'glm-5.3';
            const button = modelControl();
            if (!button) return;
            const current = label(button);
            const explicitCurrent = !/^Model$/i.test(current);
            if (explicitCurrent && modelKey(current) === modelKey(wanted) &&
                (wanted !== 'glm-5.3' || /\bThinking\b/i.test(current))) return;

            enforcing = true;
            try {
                clickMenu(button);
                if (!explicitCurrent) {
                    const selected = await waitFor(() => menus().flatMap((menu) => controls(menu)).find((el) => checked(el) === true), 1500);
                    const selectedText = label(selected);
                    if (selected && modelKey(selectedText) === modelKey(wanted) &&
                        (wanted !== 'glm-5.3' || /\bThinking\b/i.test(selectedText))) {
                        closeMenus();
                        return;
                    }
                }
                const item = await waitFor(() => menus().flatMap((menu) => controls(menu))
                    .find((el) => modelKey(label(el)) === modelKey(wanted)));
                if (!item || item.disabled || item.getAttribute('aria-disabled') === 'true' || /\bMax\b/.test(label(item))) {
                    closeMenus();
                    return;
                }
                if (wanted === 'glm-5.3') {
                    item.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
                    item.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, pointerType: 'mouse'}));
                    const toggle = await waitFor(() => menus().flatMap((menu) => controls(menu))
                        .find((el) => label(el) === 'Thinking' || el.getAttribute('role') === 'switch'), 1500);
                    if (toggle && checked(toggle) !== true) toggle.click();
                }
                item.click();
                closeMenus();
            } finally {
                enforcing = false;
            }
        }

        ipcRenderer.invoke('get-perplexity-model-policy').then((value) => {
            preferred = value?.model === 'gemini-3.8-flash'
                ? {model: 'gemini-3.8-flash', thinking: false}
                : {...defaultPolicy};
            preferenceReady = true;
            scheduleModelPolicy();
        }).catch(() => { preferenceReady = true; });

        ipcRenderer.on('perplexity-model-policy-changed', (_event, value) => {
            preferred = value?.model === 'gemini-3.8-flash'
                ? {model: 'gemini-3.8-flash', thinking: false}
                : {...defaultPolicy};
            preferenceReady = true;
            scheduleModelPolicy();
        });

        document.addEventListener('pointerdown', (event) => {
            if (!event.isTrusted) return;
            const control = event.target?.closest?.('button, [role="button"]');
            if (!control || control.closest('[role="menu"], [data-radix-menu-content]')) return;
            const value = label(control);
            if (/^Model$/i.test(value) || /\b(?:GLM|GPT|Gemini|Claude|Grok|Kimi|Nemotron|Best)(?=\d|[\s-]|$)/i.test(value)) {
                userMenuUntil = Date.now() + 5000;
            }
        }, true);

        document.addEventListener('click', (event) => {
            if (!event.isTrusted) return;
            const control = event.target?.closest?.('button, [role="button"], [role="menuitem"], [role="menuitemradio"]');
            if (!control || !control.closest('[role="menu"], [data-radix-menu-content]')) return;
            const value = label(control);
            let next = null;
            if (modelKey(value) === modelKey('glm-5.3')) next = {model: 'glm-5.3', thinking: true};
            else if (modelKey(value) === modelKey('gemini-3.8-flash')) next = {model: 'gemini-3.8-flash', thinking: false};
            if (!next) return;
            preferred = next;
            userMenuUntil = 0;
            ipcRenderer.invoke('set-perplexity-model-policy', next).catch(() => {});
        }, true);

        const modelObserver = new MutationObserver(scheduleModelPolicy);
        modelObserver.observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'aria-checked', 'data-state']});
        setInterval(enforceModelPolicy, 1000);
    }

    // Applying changes without a reload keeps Settings feeling immediate.
    ipcRenderer.on('sidebar-shortcuts-changed', (_event, ids) => {
        enabledIds = Array.isArray(ids) ? ids : [];
        syncSidebarLinks();
    });
});
