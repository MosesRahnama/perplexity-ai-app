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

    if (process.argv.includes('--simplexity-native-agent')) {
    // Native Dispatch bridge. The page can only answer narrow requests from the
    // Electron main process. It cannot reach the controller directly.
    const NATIVE_ANSWERS = '[data-message-author-role="assistant"], [data-role="assistant"], [data-testid="assistant-message"], [data-testid="answer"], .prose';
    const NATIVE_QUERIES = '[class~="group/user-bubble"]';
    const nativeSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const nativeVisible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const nativeLabel = (el) => (el?.getAttribute('aria-label') || el?.getAttribute('title') || el?.innerText || '').replace(/\s+/g, ' ').trim();

    function nativeSafePage() {
        return !/\/(?:settings|account|connectors|library|privacy|login|signin|auth|automations|skills|workflows)(?:\/|$)/i.test(location.pathname);
    }

    function nativeEditor() {
        if (!nativeSafePage()) return null;
        return [...document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], .ProseMirror[contenteditable="true"], [contenteditable="true"][data-placeholder]')]
            .find((el) => nativeVisible(el) && !el.disabled && !/search (?:sessions|connectors)/i.test(el.getAttribute('placeholder') || '')) || null;
    }

    function nativeDraft(el) {
        if (!el) return '';
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return (el.value || '').trim();
        const clone = el.cloneNode(true);
        clone.querySelectorAll('[contenteditable="false"]').forEach((node) => node.remove());
        return (clone.textContent || '').trim();
    }

    function nativeRoot() {
        const main = [...document.querySelectorAll('main, [role="main"], [role="log"], [data-testid="thread-content"]')].find(nativeVisible);
        if (main) return main;
        let node = nativeEditor()?.parentElement;
        for (let i = 0; node && i < 7; i++, node = node.parentElement) {
            if (node.querySelector(NATIVE_ANSWERS) && !node.querySelector('nav, aside, [role="navigation"]')) return node;
        }
        return null;
    }

    function nativeAnswerNodes() {
        const area = nativeRoot();
        if (!area) return [];
        const found = [...area.querySelectorAll(NATIVE_ANSWERS)].filter((el) => nativeVisible(el) &&
            !el.closest('[data-message-author-role="user"], [data-role="user"]'));
        return found.filter((el) => !found.some((parent) => parent !== el && parent.contains(el)));
    }

    function nativeAnswer() { return (nativeAnswerNodes().at(-1)?.innerText || '').trim(); }

    function nativeBusy() {
        const stop = [...document.querySelectorAll('button')].find((el) => nativeVisible(el) &&
            /^stop(?:\s+(?:generating|response|answer|task|work|research))?(?:\s*\(Esc\))?$/i.test(nativeLabel(el)));
        return !!stop || [...(nativeRoot()?.querySelectorAll('[aria-busy="true"]') || [])].some(nativeVisible);
    }

    function nativeNeedsApproval(text) {
        if ([...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(nativeVisible)) return true;
        return /confirm_action|(?:I need|I require|waiting for|requires? your|please give|please grant).{0,60}(?:permission|approval|consent)|please confirm|(?:sign[ -]?in|log[ -]?in|authorize).{0,35}(?:to continue|before|access)|(?:click|select|press).{0,30}(?:allow|approve|authorize|confirm)|complete.{0,20}captcha/i.test(text || '');
    }

    function nativeConnectionError() {
        const notices = [...(nativeRoot()?.querySelectorAll('[role="alert"], [role="status"], [data-testid*="error"]') || [])]
            .filter(nativeVisible).map((el) => el.innerText).join('\n');
        return /connection (?:lost|timed? out)|waiting for (?:a )?connection|reconnecting|thinking failed|something (?:went|has gone) wrong/i.test(notices) && !nativeNeedsApproval(notices);
    }

    function nativeModelText() {
        const editor = nativeEditor();
        const area = editor?.closest('form') || editor?.parentElement?.parentElement?.parentElement;
        const controls = [...(area || document).querySelectorAll('button, [role="button"]')].filter(nativeVisible);
        return nativeLabel(controls.find((el) => /\b(?:GLM|GPT|Gemini|Claude|Grok|Kimi|Nemotron|Best)(?=\d|[\s-]|$)/i.test(nativeLabel(el)))) || '';
    }

    function nativeSearchMode() {
        return [...document.querySelectorAll('button, [role="button"]')].filter(nativeVisible)
            .some((el) => /^Search$/i.test(nativeLabel(el)));
    }

    function nativeState() {
        const editor = nativeEditor();
        const answer = nativeAnswer();
        return {
            ready: !!editor && nativeSearchMode(),
            busy: nativeBusy(),
            needsApproval: nativeNeedsApproval(answer),
            connectionError: nativeConnectionError(),
            answer,
            body: (nativeRoot()?.innerText || '').trim().slice(0, 900000),
            turns: nativeAnswerNodes().length,
            title: document.title,
            url: location.origin + location.pathname,
            model: nativeModelText(),
            draft: nativeDraft(editor),
        };
    }

    async function nativeSend(text) {
        const state = nativeState();
        const editor = nativeEditor();
        if (!state.ready || !editor) throw new Error('Perplexity Search composer is not ready');
        if (state.busy || state.needsApproval || state.connectionError) throw new Error('Perplexity is not in a safe send state');
        if (state.draft) throw new Error('Perplexity composer already contains a draft');
        if (!/glm\s*-?\s*5\.3/i.test(state.model) || !/thinking/i.test(state.model)) {
            throw new Error(`Expected GLM 5.3 Thinking before send; found ${state.model || 'no readable model label'}`);
        }

        const queryCount = nativeRoot()?.querySelectorAll(NATIVE_QUERIES).length || 0;
        editor.focus();
        if (editor.tagName === 'TEXTAREA') {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, text);
            editor.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: text}));
        } else {
            const range = document.createRange();
            const paragraphs = editor.querySelectorAll('p');
            range.selectNodeContents(paragraphs.length ? paragraphs[paragraphs.length - 1] : editor);
            range.collapse(false);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            if (!document.execCommand('insertText', false, text)) throw new Error('Perplexity editor did not accept the text');
        }

        await nativeSleep(150);
        const form = editor.closest('form');
        const scopes = [form, nativeRoot(), document].filter(Boolean);
        let button = null;
        for (const scope of scopes) {
            button = [...scope.querySelectorAll('button')].find((node) => nativeVisible(node) && !node.disabled &&
                (node.type === 'submit' || /^(?:send|submit|ask)(?: message| prompt| question| perplexity)?$|^start task$/i.test(nativeLabel(node))));
            if (button) break;
        }
        if (button) {
            button.click();
        } else if (form && typeof form.requestSubmit === 'function') {
            form.requestSubmit();
        } else {
            editor.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true, cancelable: true}));
            editor.dispatchEvent(new KeyboardEvent('keyup', {key: 'Enter', code: 'Enter', bubbles: true, cancelable: true}));
        }

        const until = Date.now() + 30000;
        while (Date.now() < until) {
            const queries = [...(nativeRoot()?.querySelectorAll(NATIVE_QUERIES) || [])];
            const accepted = queries.length > queryCount && (queries.at(-1)?.innerText || '').includes(text.slice(-160));
            if (!nativeDraft(nativeEditor()) && accepted) return nativeState();
            await nativeSleep(250);
        }
        throw new Error('Send outcome is unknown; no automatic duplicate was sent');
    }

    ipcRenderer.on('simplexity-native-dispatch-command', async (_event, message) => {
        const requestId = Number(message?.requestId);
        try {
            let result;
            if (message?.type === 'probe' || message?.type === 'state') result = nativeState();
            else if (message?.type === 'send') result = await nativeSend(String(message?.payload?.text || ''));
            else throw new Error('Unknown native Dispatch page command');
            ipcRenderer.send('simplexity-native-dispatch-result', {requestId, ok: true, result});
        } catch (error) {
            const detail = String(error.message).slice(0, 300);
            ipcRenderer.send('simplexity-native-dispatch-result', {
                requestId,
                ok: false,
                detail,
                uncertain: /^Send outcome is unknown;/i.test(detail),
            });
        }
    });
    }

    // Applying changes without a reload keeps Settings feeling immediate.
    ipcRenderer.on('sidebar-shortcuts-changed', (_event, ids) => {
        enabledIds = Array.isArray(ids) ? ids : [];
        syncSidebarLinks();
    });
});
