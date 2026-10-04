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

    // App-wide Perplexity policy: keep GLM 5.3 + Thinking selected and answer
    // Perplexity's generic yes/no continuation prompt once per rendered answer.
    const POLICY_ANSWERS = '[data-message-author-role="assistant"], [data-role="assistant"], [data-testid="assistant-message"], [data-testid="answer"], .prose';
    const policySleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const policyVisible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const policyText = (el) => (el?.getAttribute('aria-label') || el?.getAttribute('title') || el?.innerText || '').replace(/\s+/g, ' ').trim();
    const policyControls = (root = document) => [...root.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="switch"]')].filter(policyVisible);
    const policyMenus = () => [...document.querySelectorAll('[role="menu"], [data-radix-menu-content]')].filter(policyVisible);
    const policyChecked = (el) => {
        if (!el) return null;
        const value = String(el.getAttribute('aria-checked') || el.getAttribute('data-state') || '').toLowerCase();
        return ['true', 'checked', 'on', 'selected'].includes(value) ? true : ['false', 'unchecked', 'off'].includes(value) ? false : null;
    };
    const policyModelKey = (value) => String(value).toLowerCase().replace(/\b(?:thinking|max)\b/g, '').replace(/[^a-z0-9]/g, '');
    const policyIsNativeAgent = process.argv.includes('--simplexity-native-agent');
    const policyDefaultModel = {model: 'glm-5.3', thinking: true};
    let policyPreferredModel = {...policyDefaultModel};
    let policyPreferenceReady = policyIsNativeAgent;
    if (!policyIsNativeAgent) {
        ipcRenderer.invoke('get-perplexity-model-policy').then((value) => {
            if (value?.model === 'gemini-3.8-flash') policyPreferredModel = {model: 'gemini-3.8-flash', thinking: false};
            else policyPreferredModel = {...policyDefaultModel};
            policyPreferenceReady = true;
            schedulePerplexityPolicy();
        }).catch(() => { policyPreferenceReady = true; });
        ipcRenderer.on('perplexity-model-policy-changed', (_event, value) => {
            policyPreferredModel = value?.model === 'gemini-3.8-flash'
                ? {model: 'gemini-3.8-flash', thinking: false}
                : {...policyDefaultModel};
            schedulePerplexityPolicy();
        });
    }
    const policyCloseMenus = () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', bubbles: true}));
    const policyClickMenu = (el) => {
        const event = {bubbles: true, button: 0, pointerType: 'mouse', isPrimary: true};
        el.dispatchEvent(new PointerEvent('pointerdown', event));
        el.dispatchEvent(new PointerEvent('pointerup', event));
        el.click();
    };
    const policyWaitFor = async (read, ms = 4000) => {
        const until = Date.now() + ms;
        while (Date.now() < until) {
            const value = read();
            if (value) return value;
            await policySleep(100);
        }
        return null;
    };
    const policyEditor = () => [...document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], .ProseMirror[contenteditable="true"], [contenteditable="true"][data-placeholder]')]
        .find((el) => policyVisible(el) && !el.disabled && !/search (?:sessions|connectors)/i.test(el.getAttribute('placeholder') || '')) || null;
    const policyDraft = (el) => {
        if (!el) return '';
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return (el.value || '').trim();
        const clone = el.cloneNode(true);
        clone.querySelectorAll('[contenteditable="false"]').forEach((node) => node.remove());
        return (clone.textContent || '').trim();
    };
    const policyRoot = () => [...document.querySelectorAll('main, [role="main"], [role="log"], [data-testid="thread-content"]')].find(policyVisible) || null;
    const policyAnswerState = () => {
        const area = policyRoot();
        if (!area) return {text: '', turn: 0};
        const found = [...area.querySelectorAll(POLICY_ANSWERS)].filter((el) => policyVisible(el) && !el.closest('[data-message-author-role="user"], [data-role="user"]'));
        const leaves = found.filter((el) => !found.some((parent) => parent !== el && parent.contains(el)));
        const latest = leaves.at(-1) || null;
        const turn = latest?.getAttribute('data-message-id') || latest?.id || String(leaves.length);
        return {text: (latest?.innerText || '').trim(), turn};
    };
    const policyBusy = () => policyControls().some((el) => /^stop(?:\s+(?:generating|response|answer|task|work|research))?(?:\s*\(Esc\))?$/i.test(policyText(el))) ||
        [...(policyRoot()?.querySelectorAll('[aria-busy="true"]') || [])].some(policyVisible);
    const policyApprovalDialog = () => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(policyVisible);
    const policyProtectedAction = (text) => {
        const body = String(text || '').replace(/\s+/g, ' ');
        // Auto-confirm must never stand in for the operator on protected external actions.
        // Conservative matching is intentional: a harmless false block is safer than approving one.
        return /\b(?:e-?mail|gmail|outlook|openrouter|droid)\b/i.test(body) ||
            /\b(?:send_email|send_mail|gmail_send|outlook_send|dispatch_new)\b/i.test(body) ||
            /["']agent["']\s*:\s*["']droid["']/i.test(body);
    };
    const policyModelControl = () => {
        const editor = policyEditor();
        const area = editor?.closest('form') || editor?.parentElement?.parentElement?.parentElement;
        return policyControls(area || document).find((el) =>
            /^Model$/i.test(policyText(el)) || /\b(?:GLM|GPT|Gemini|Claude|Grok|Kimi|Nemotron|Best)(?=\d|[\s-]|$)/i.test(policyText(el))) || null;
    };

    let policyModelRunning = false;
    let policyUserModelMenuUntil = 0;
    async function policyEnforceModel() {
        if (policyModelRunning || !policyPreferenceReady || (!policyIsNativeAgent && Date.now() < policyUserModelMenuUntil)) return;
        const target = policyIsNativeAgent ? policyDefaultModel : policyPreferredModel;
        const wanted = target.model === 'gemini-3.8-flash' ? 'gemini-3.8-flash' : 'glm-5.3';
        const button = policyModelControl();
        if (!button) return;
        const current = policyText(button);
        const explicitCurrent = !/^Model$/i.test(current);
        const currentMatches = explicitCurrent && policyModelKey(current) === policyModelKey(wanted) &&
            (wanted !== 'glm-5.3' || /\bThinking\b/i.test(current));
        if (currentMatches) return;
        policyModelRunning = true;
        try {
            policyClickMenu(button);
            if (!explicitCurrent) {
                const selected = await policyWaitFor(() => policyMenus().flatMap((menu) => policyControls(menu))
                    .find((el) => policyChecked(el) === true), 1500);
                const selectedText = policyText(selected);
                const selectedMatches = selected && policyModelKey(selectedText) === policyModelKey(wanted) &&
                    (wanted !== 'glm-5.3' || /\bThinking\b/i.test(selectedText));
                if (selectedMatches) {
                    policyCloseMenus();
                    return;
                }
            }
            const item = await policyWaitFor(() => policyMenus().flatMap((menu) => policyControls(menu))
                .find((el) => policyModelKey(policyText(el)) === policyModelKey(wanted)), 4000);
            if (!item || item.disabled || item.getAttribute('aria-disabled') === 'true' || /\bMax\b/.test(policyText(item))) {
                policyCloseMenus();
                throw new Error(`${wanted} is unavailable or locked`);
            }
            if (wanted === 'glm-5.3') {
                item.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
                item.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, pointerType: 'mouse'}));
                const toggle = await policyWaitFor(() => policyMenus().flatMap((menu) => policyControls(menu))
                    .find((el) => policyText(el) === 'Thinking' || el.getAttribute('role') === 'switch'), 1500);
                if (toggle && policyChecked(toggle) !== true) toggle.click();
            }
            item.click();
            policyCloseMenus();
            const chosen = await policyWaitFor(() => {
                const value = policyText(policyModelControl());
                const modelMatches = policyModelKey(value) === policyModelKey(wanted);
                const thinkingMatches = wanted !== 'glm-5.3' || /\bThinking\b/i.test(value);
                return modelMatches && thinkingMatches ? value : null;
            }, 4000);
            if (!chosen) throw new Error(`Perplexity did not confirm ${wanted}${wanted === 'glm-5.3' ? ' with Thinking enabled' : ''}`);
        } finally {
            policyModelRunning = false;
        }
    }

    document.addEventListener('pointerdown', (event) => {
        if (policyIsNativeAgent || !event.isTrusted) return;
        const control = event.target?.closest?.('button, [role="button"]');
        if (!control || control.closest('[role="menu"], [data-radix-menu-content]')) return;
        const value = policyText(control);
        if (/^Model$/i.test(value) || /\b(?:GLM|GPT|Gemini|Claude|Grok|Kimi|Nemotron|Best)(?=\d|[\s-]|$)/i.test(value)) {
            policyUserModelMenuUntil = Date.now() + 5000;
        }
    }, true);

    document.addEventListener('click', (event) => {
        if (policyIsNativeAgent || !event.isTrusted) return;
        const control = event.target?.closest?.('button, [role="button"], [role="menuitem"], [role="menuitemradio"]');
        if (!control || !control.closest('[role="menu"], [data-radix-menu-content]')) return;
        const value = policyText(control);
        let next = null;
        if (policyModelKey(value) === policyModelKey('glm-5.3')) next = {model: 'glm-5.3', thinking: true};
        else if (policyModelKey(value) === policyModelKey('gemini-3.8-flash')) next = {model: 'gemini-3.8-flash', thinking: false};
        if (!next) return;
        policyPreferredModel = next;
        policyPreferenceReady = true;
        policyUserModelMenuUntil = 0;
        ipcRenderer.invoke('set-perplexity-model-policy', next).catch(() => {});
    }, true);

    const POLICY_CONFIRMATION = /\bReply\s+(?:with\s+)?(?:\*\*)?["“'‘]?yes["”'’]?(?:\*\*)?\s+to\s+proceed\s*,?\s+or\s+(?:\*\*)?["“'‘]?no["”'’]?(?:\*\*)?(?:(?:\s+to\s+cancel\.?)|(?=\s*$))/i;
    let policyLastYesKey = '';
    const policyApprovalStorageKey = 'simplexityPerplexityAutoYes';
    const policyWasAutoYesSent = (key) => {
        if (policyLastYesKey === key) return true;
        try {
            const saved = JSON.parse(sessionStorage.getItem(policyApprovalStorageKey) || '{}') || {};
            return saved[key] === true;
        } catch {
            return false;
        }
    };
    const policyRememberAutoYes = (key) => {
        policyLastYesKey = key;
        try {
            const saved = JSON.parse(sessionStorage.getItem(policyApprovalStorageKey) || '{}') || {};
            saved[key] = true;
            sessionStorage.setItem(policyApprovalStorageKey, JSON.stringify(Object.fromEntries(Object.entries(saved).slice(-50))));
        } catch {
        }
    };
    async function policyAutoYes() {
        const answerState = policyAnswerState();
        const answer = answerState.text;
        if (!POLICY_CONFIRMATION.test(answer) || policyBusy() || policyApprovalDialog() || policyProtectedAction(answer)) return;
        const key = `${location.pathname}|${answerState.turn}`;
        if (policyWasAutoYesSent(key)) return;
        const editor = policyEditor();
        if (!editor || policyDraft(editor)) return;
        editor.focus();
        const inserted = await ipcRenderer.invoke('perplexity-policy-insert-text', 'yes');
        if (!inserted) return;
        await policySleep(100);
        if (policyDraft(editor).toLowerCase() !== 'yes') return;
        const form = editor.closest('form');
        const scopes = [form, policyRoot(), document].filter(Boolean);
        let button = null;
        for (const scope of scopes) {
            button = policyControls(scope).find((node) => !node.disabled &&
                (node.type === 'submit' || /^(?:send|submit|ask)(?: message| prompt| question| perplexity)?$|^start task$/i.test(policyText(node))));
            if (button) break;
        }
        if (!button) return;
        policyRememberAutoYes(key);
        button.click();
    }

    let policyRunActive = false;
    let policyDebounce = null;
    async function runPerplexityPolicy() {
        if (policyRunActive) return;
        policyRunActive = true;
        try {
            await policyEnforceModel();
            await policyAutoYes();
        } catch (error) {
            console.warn('Simplexity Perplexity policy:', error.message);
        } finally {
            policyRunActive = false;
        }
    }
    const schedulePerplexityPolicy = () => {
        clearTimeout(policyDebounce);
        policyDebounce = setTimeout(runPerplexityPolicy, 120);
    };
    const policyObserver = new MutationObserver(schedulePerplexityPolicy);
    policyObserver.observe(document.body, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'aria-checked', 'data-state']});
    setInterval(runPerplexityPolicy, 1000);
    setTimeout(runPerplexityPolicy, 250);

    if (process.argv.includes('--simplexity-native-agent')) {
    // Native Dispatch bridge. The page can only answer narrow requests from the
    // Electron main process. It cannot reach the controller directly.
    const NATIVE_ANSWERS = '[data-message-author-role="assistant"], [data-role="assistant"], [data-testid="assistant-message"], [data-testid="answer"], .prose';
    const NATIVE_QUERIES = '[class~="group/user-bubble"]';
    const nativeSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const nativeVisible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const nativeLabel = (el) => (el?.getAttribute('aria-label') || el?.getAttribute('title') || el?.innerText || '').replace(/\s+/g, ' ').trim();
    const nativeProofText = (value) => String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();

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
        if (POLICY_CONFIRMATION.test(text || '')) return true;
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
        const queries = [...(nativeRoot()?.querySelectorAll(NATIVE_QUERIES) || [])];
        const queryStartIndex = Math.max(0, queries.length - 20);
        return {
            ready: !!editor && nativeSearchMode(),
            busy: nativeBusy(),
            needsApproval: nativeNeedsApproval(answer),
            connectionError: nativeConnectionError(),
            answer,
            body: (nativeRoot()?.innerText || '').trim().slice(0, 900000),
            turns: nativeAnswerNodes().length,
            queryCount: queries.length,
            lastQuery: (queries.at(-1)?.innerText || '').trim().slice(0, 200000),
            queryStartIndex,
            recentQueries: queries.slice(queryStartIndex).map((node) => (node.innerText || '').trim().slice(0, 200000)),
            title: document.title,
            url: location.origin + location.pathname,
            model: nativeModelText(),
            draft: nativeDraft(editor),
        };
    }

    function nativePrepareSend() {
        const state = nativeState();
        const editor = nativeEditor();
        if (!state.ready || !editor) throw new Error('Perplexity Search composer is not ready');
        if (state.busy || state.needsApproval || state.connectionError) throw new Error('Perplexity is not in a safe send state');
        if (state.draft) throw new Error('Perplexity composer already contains a draft');
        if (!/glm\s*-?\s*5\.3/i.test(state.model) || !/thinking/i.test(state.model)) {
            throw new Error(`Expected GLM 5.3 Thinking before send; found ${state.model || 'no readable model label'}`);
        }
        editor.focus();
        return state;
    }

    async function nativeSubmit(text, baselineQueryCount) {
        const editor = nativeEditor();
        if (!editor) throw new Error('Perplexity Search composer is not ready');
        const draftText = nativeDraft(editor);
        if (draftText !== text) {
            throw new Error('Perplexity editor does not contain the requested text; no submit was clicked');
        }

        const scopes = [nativeRoot(), document].filter(Boolean);
        let button = null;
        for (const scope of scopes) {
            button = [...scope.querySelectorAll('button')].find((node) => nativeVisible(node) && !node.disabled &&
                /^(?:send|submit|ask)(?: message| prompt| question| perplexity)?$|^start task$/i.test(nativeLabel(node)));
            if (button) break;
        }
        if (!button) throw new Error('Perplexity Submit button was not found; no submit was clicked');
        button.click();

        const until = Date.now() + 30000;
        while (Date.now() < until) {
            const queries = [...(nativeRoot()?.querySelectorAll(NATIVE_QUERIES) || [])];
            const accepted = queries.length > Number(baselineQueryCount || 0) &&
                nativeProofText(queries.at(-1)?.innerText || '').includes(nativeProofText(text).slice(-160));
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
            else if (message?.type === 'prepare-send') result = nativePrepareSend();
            else if (message?.type === 'submit') result = await nativeSubmit(
                String(message?.payload?.text || ''), Number(message?.payload?.baselineQueryCount || 0));
            else throw new Error('Unknown native Dispatch page command');
            ipcRenderer.send('simplexity-native-dispatch-result', {requestId, ok: true, result});
        } catch (error) {
            const detail = String(error.message).slice(0, 300);
            ipcRenderer.send('simplexity-native-dispatch-result', {
                requestId,
                ok: false,
                detail,
                uncertain: message?.type === 'submit' && /^Send outcome is unknown;/i.test(detail),
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
