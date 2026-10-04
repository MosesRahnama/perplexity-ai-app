'use strict';

const BASE = 'http://127.0.0.1:8792';
const HOME = 'https://www.perplexity.ai/';
const SURFACE = 'perplexity';
const RECOVERY_KEY = 'nativeDispatchRecovery';
const RECOVERY_VERSION = 1;

function createNativeDispatch({BrowserWindow, BrowserView, ipcMain, shell, path, settings, appDir}) {
  let agentView = null;
  let agentHostWindow = null;
  let timer = null;
  let running = false;
  let recoveryReady = false;
  let requestId = 0;
  const pendingPage = new Map();
  let conversation = null;

  function isPerplexityUrl(value) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' &&
        (parsed.hostname === 'perplexity.ai' || parsed.hostname === 'www.perplexity.ai');
    } catch {
      return false;
    }
  }

  function isConversationUrl(value) {
    try {
      const parsed = new URL(value);
      return isPerplexityUrl(value) && /^\/search\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function recoverySnapshot() {
    if (!conversation) return null;
    const liveUrl = agentView && !agentView.webContents.isDestroyed() ? agentView.webContents.getURL() : '';
    return {
      version: RECOVERY_VERSION,
      conversation: {
        id: String(conversation.id || ''),
        lane: String(conversation.lane || ''),
        model: String(conversation.model || 'glm-5.3'),
        reasoning: String(conversation.reasoning || 'thinking'),
        pageUrl: isPerplexityUrl(liveUrl) ? liveUrl : String(conversation.pageUrl || ''),
        openingBaseline: String(conversation.openingBaseline || ''),
        openingLastAnswer: String(conversation.openingLastAnswer || ''),
        openingChangedAt: Number(conversation.openingChangedAt || Date.now()),
        openingDone: !!conversation.openingDone,
        openingUncertain: !!conversation.openingUncertain,
        openingCommand: conversation.openingCommand ? {...conversation.openingCommand} : null,
        pending: conversation.pending ? {...conversation.pending} : null,
      },
    };
  }

  function saveRecovery() {
    if (!settings) return;
    const record = recoverySnapshot();
    if (record) settings.set(RECOVERY_KEY, record);
    else settings.delete(RECOVERY_KEY);
  }

  function clearRecovery() {
    if (settings) settings.delete(RECOVERY_KEY);
  }

  function loadRecovery() {
    if (!settings) return null;
    const record = settings.get(RECOVERY_KEY, null);
    if (!record || Number(record.version) !== RECOVERY_VERSION || !record.conversation) return null;
    const value = record.conversation;
    if (!value.id || !value.lane) return null;
    return value;
  }

  function hydrateRecovery(value) {
    conversation = {
      id: String(value.id),
      lane: String(value.lane),
      model: String(value.model || 'glm-5.3'),
      reasoning: String(value.reasoning || 'thinking'),
      pageUrl: isPerplexityUrl(value.pageUrl) ? String(value.pageUrl) : HOME,
      pending: value.pending ? {...value.pending} : null,
      lastTranscript: '',
      openingBaseline: String(value.openingBaseline || ''),
      openingLastAnswer: String(value.openingLastAnswer || ''),
      openingChangedAt: Number(value.openingChangedAt || Date.now()),
      openingDone: !!value.openingDone,
      openingUncertain: !!value.openingUncertain,
      openingCommand: value.openingCommand ? {...value.openingCommand} : null,
    };
  }

  async function request(route, body) {
    const response = await fetch(BASE + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {'Content-Type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Dispatch HTTP ' + response.status);
    return response.json();
  }

  function pageRequest(type, payload = {}, timeoutMs = 15000, options = {}) {
    if (!agentView || agentView.webContents.isDestroyed()) {
      return Promise.reject(new Error('Native Perplexity Agent BrowserView is unavailable'));
    }
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      let settled = false;
      const webContents = agentView.webContents;
      const cleanupNavigation = () => {
        if (!options.allowConversationNavigation) return;
        webContents.removeListener('did-navigate', onNavigate);
        webContents.removeListener('did-navigate-in-page', onNavigate);
      };
      const finishResolve = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timerId);
        cleanupNavigation();
        pendingPage.delete(id);
        resolve(value);
      };
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timerId);
        cleanupNavigation();
        pendingPage.delete(id);
        reject(error);
      };
      const onNavigate = (_event, url) => {
        if (!isConversationUrl(url)) return;
        finishResolve({navigationAccepted: true, url});
      };
      const timerId = setTimeout(() => {
        const error = new Error('Perplexity page did not answer ' + type);
        error.uncertain = type === 'submit';
        finishReject(error);
      }, timeoutMs);
      pendingPage.set(id, {resolve: finishResolve, reject: finishReject});
      if (options.allowConversationNavigation) {
        webContents.on('did-navigate', onNavigate);
        webContents.on('did-navigate-in-page', onNavigate);
      }
      try {
        webContents.send('simplexity-native-dispatch-command', {requestId: id, type, payload});
      } catch (error) {
        error.uncertain = type === 'submit';
        finishReject(error);
      }
    });
  }

  async function sendNativeText(text, options = {}) {
    const prepared = await pageRequest('prepare-send', {}, 5000);
    const webContents = agentView && agentView.webContents;
    if (!webContents || webContents.isDestroyed()) throw new Error('Native Perplexity Agent BrowserView is unavailable');
    webContents.focus();
    await webContents.insertText(String(text || ''));
    await new Promise((resolve) => setTimeout(resolve, 150));
    return pageRequest('submit', {
      text: String(text || ''),
      baselineQueryCount: Number(prepared.queryCount || 0),
    }, 35000, options);
  }
  function onPageResult(event, message) {
    if (!agentView || event.sender !== agentView.webContents) return;
    if (!isPerplexityUrl(event.sender.getURL())) return;
    const id = Number(message && message.requestId);
    const pending = pendingPage.get(id);
    if (!pending) return;
    pendingPage.delete(id);
    if (message && message.ok) {
      pending.resolve(message.result || {});
    } else {
      const error = new Error(String((message && message.detail) || 'Perplexity page action failed').slice(0, 300));
      error.uncertain = !!(message && message.uncertain);
      pending.reject(error);
    }
  }

  async function ensureReady() {
    if (!agentView || agentView.webContents.isDestroyed()) {
      if (!agentHostWindow || agentHostWindow.isDestroyed()) {
        agentHostWindow = new BrowserWindow({
          show: false,
          width: 1280,
          height: 900,
          webPreferences: {contextIsolation: true, nodeIntegration: false},
        });
      }
      agentView = new BrowserView({
        webPreferences: {
          contextIsolation: true,
          preload: path.join(appDir, 'src', 'js', 'preload', 'preload_inject.js'),
          backgroundThrottling: true,
          sandbox: false,
          spellcheck: true,
          additionalArguments: ['--simplexity-native-agent'],
        },
      });
      agentHostWindow.setBrowserView(agentView);
      agentView.setBounds({x: 0, y: 0, width: 1280, height: 900});
      agentView.setAutoResize({width: true, height: true});
      agentView.webContents.setWindowOpenHandler(({url}) => {
        if (url) shell.openExternal(url);
        return {action: 'deny'};
      });
      await agentView.webContents.loadURL(HOME);
    }

    const deadline = Date.now() + 20000;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await pageRequest('probe', {}, 4000);
        if (last.ready && /glm\s*-?\s*5\.3/i.test(String(last.model || '')) && /thinking/i.test(String(last.model || ''))) return last;
      } catch {
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(last && last.model ? 'Perplexity Agent view is not ready; model ' + last.model : 'Perplexity Agent view is not ready');
  }

  async function resetConversationPage() {
    await ensureReady();
    await agentView.webContents.loadURL(HOME);
    return ensureReady();
  }

  function chatState(page) {
    if (page.needsApproval) return 'error';
    if (page.connectionError) return 'stalled';
    if (page.busy) return 'answering';
    return page.ready ? 'idle' : 'unknown';
  }

  async function publish(page) {
    if (!conversation) return;
    const url = String(page.url || agentView.webContents.getURL() || '').slice(0, 300);
    if (url && url !== conversation.pageUrl) {
      conversation.pageUrl = url;
      saveRecovery();
    }
    await request('/api/chats', {
      conversation_id: conversation.id,
      lane: conversation.lane,
      surface: SURFACE,
      title: String(page.title || 'Perplexity').slice(0, 200),
      state: chatState(page),
      turns: Math.max(0, Number(page.turns) || 0),
      url,
      last_activity: new Date().toISOString(),
      mode: 'unknown',
      mode_evidence: 'Perplexity Search',
      model: String(page.model || conversation.model || '').slice(0, 100),
      reasoning: String(conversation.reasoning || '').slice(0, 40),
    });

    const body = String(page.body || '').trim().slice(0, 900000);
    if (body && body !== conversation.lastTranscript) {
      conversation.lastTranscript = body;
      await request('/api/chats/' + encodeURIComponent(conversation.id) + '/transcript', {
        surface: SURFACE,
        lane: conversation.lane,
        url,
        title: String(page.title || 'Perplexity').slice(0, 200),
        body,
      });
    }
  }

  async function finishOpening(page) {
    if (!conversation || conversation.openingDone) return;
    const answer = String(page.answer || '');
    if (answer !== conversation.openingLastAnswer) {
      conversation.openingLastAnswer = answer;
      conversation.openingChangedAt = Date.now();
    }
    if (!answer || answer === conversation.openingBaseline || page.busy || page.needsApproval ||
        page.connectionError || Date.now() - conversation.openingChangedAt < 8000) return;
    conversation.openingDone = true;
    saveRecovery();
  }

  async function reconcilePendingDelivery() {
    const pending = conversation && conversation.pending;
    if (!pending) return true;
    if (pending.phase === 'send-uncertain') return false;
    if (pending.phase === 'send-failed') {
      try {
        await request('/api/chat-messages/' + pending.id + '/delivered', {
          ok: false,
          detail: pending.failureDetail || 'Perplexity send failed',
        });
        conversation.pending = null;
        saveRecovery();
        return true;
      } catch {
        return false;
      }
    }
    if (pending.phase === 'sent-awaiting-ack') {
      try {
        await request('/api/chat-messages/' + pending.id + '/delivered', {ok: true, detail: ''});
        pending.phase = 'delivered';
        saveRecovery();
      } catch {
        return false;
      }
    }
    return pending.phase === 'delivered';
  }

  async function finishFollowup(page) {
    const pending = conversation && conversation.pending;
    if (!pending) return;
    if (pending.phase === 'reply-started') {
      await request('/api/chat-messages/' + pending.id + '/reply', {reply: String(pending.replyText || '').slice(0, 200000)});
      conversation.pending = null;
      saveRecovery();
      return;
    }
    if (pending.phase !== 'delivered') return;
    const answer = String(page.answer || '');
    if (answer !== pending.lastAnswer) {
      pending.lastAnswer = answer;
      pending.changedAt = Date.now();
      saveRecovery();
    }
    if (!answer || answer === pending.baselineAnswer || page.busy || page.needsApproval ||
        page.connectionError || Date.now() - pending.changedAt < 8000) return;
    pending.replyText = answer.slice(0, 200000);
    pending.phase = 'reply-started';
    saveRecovery();
    await request('/api/chat-messages/' + pending.id + '/reply', {reply: pending.replyText});
    conversation.pending = null;
    saveRecovery();
  }

  async function maybeSendFollowup(page) {
    if (!conversation || !conversation.openingDone || conversation.pending || page.busy ||
        page.needsApproval || page.connectionError || !page.ready) return;
    const claimed = await request('/api/chats/' + encodeURIComponent(conversation.id) + '/next', {});
    const message = claimed.message;
    if (!message) return;

    const baselineAnswer = String(page.answer || '');
    const baselineQueryCount = Number(page.queryCount || 0);
    const messageBody = String(message.body || '');
    conversation.pending = {
      id: Number(message.id),
      body: messageBody,
      baselineAnswer,
      baselineQueryCount,
      lastAnswer: baselineAnswer,
      changedAt: Date.now(),
      phase: 'claimed',
      failureDetail: '',
    };
    saveRecovery();
    try {
      conversation.pending.phase = 'submit-started';
      saveRecovery();
      await sendNativeText(conversation.pending.body);
      conversation.pending.phase = 'sent-awaiting-ack';
      saveRecovery();
    } catch (error) {
      conversation.pending.failureDetail = String(error.message).slice(0, 300);
      if (error.uncertain) {
        try {
          await verifySubmittedQuery(conversation.pending.body, {baselineQueryCount, timeoutMs: 20000});
          conversation.pending.phase = 'sent-awaiting-ack';
          saveRecovery();
        } catch (verifyError) {
          conversation.pending.phase = 'send-uncertain';
          conversation.pending.failureDetail = String(verifyError.message).slice(0, 300);
          saveRecovery();
          return;
        }
      } else {
        conversation.pending.phase = 'send-failed';
        saveRecovery();
      }
    }
    await reconcilePendingDelivery();
  }

  async function monitor() {
    if (!conversation || !agentView || agentView.webContents.isDestroyed()) return;
    if (!isPerplexityUrl(agentView.webContents.getURL())) return;
    let page = await pageRequest('state', {}, 5000);
    await publish(page);
    if (conversation.openingCommand) {
      if (!await recoverOpening(page)) return;
      if (!conversation) return;
      page = await pageRequest('state', {}, 5000);
    }
    await finishOpening(page);
    if (!await reconcilePendingDelivery()) return;
    await finishFollowup(page);
    await maybeSendFollowup(page);
  }

  function comparableQueryText(value) {
    return String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
  }

  async function verifySubmittedQuery(text, options = {}) {
    const tail = comparableQueryText(text).slice(-160);
    const baselineQueryCount = Number(options.baselineQueryCount || 0);
    const requireConversationUrl = !!options.requireConversationUrl;
    const timeoutMs = Number(options.timeoutMs || 20000);
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await pageRequest('state', {}, 5000);
        const urlOk = !requireConversationUrl || isConversationUrl(last.url);
        const queryCount = Number(last.queryCount || 0);
        const recentQueries = Array.isArray(last.recentQueries) ? last.recentQueries : [last.lastQuery || ''];
        const startIndex = Number.isFinite(Number(last.queryStartIndex))
          ? Number(last.queryStartIndex)
          : Math.max(0, queryCount - recentQueries.length);
        const matchingRenderedQuery = recentQueries.some((query, index) =>
          startIndex + index >= baselineQueryCount && comparableQueryText(query).includes(tail));
        if (urlOk && queryCount > baselineQueryCount && matchingRenderedQuery && !String(last.draft || '').trim()) {
          return last;
        }
      } catch {
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const error = new Error('Perplexity send could not be verified from the rendered user query; no automatic duplicate was sent');
    error.uncertain = true;
    throw error;
  }
  async function openConversation(command) {
    if (conversation) return {ok: false, detail: 'The native Perplexity receiver already owns a conversation'};
    const model = String(command.model || 'glm-5.3').toLowerCase();
    const reasoning = String(command.reasoning || 'thinking').toLowerCase();
    if (model !== 'glm-5.3' || !['thinking', 'extra-high'].includes(reasoning)) {
      return {ok: false, detail: 'PR2 only accepts GLM 5.3 with Thinking; no model or mode was changed'};
    }

    const ready = await resetConversationPage();
    const id = require('crypto').randomUUID();
    const prompt = String(command.prompt || '');
    const baselineQueryCount = Number(ready.queryCount || 0);
    conversation = {
      id,
      lane: String(command.lane || 'sup-perplexity').slice(0, 100),
      model: 'glm-5.3',
      reasoning: 'thinking',
      pageUrl: HOME,
      pending: null,
      lastTranscript: '',
      openingBaseline: String(ready.answer || ''),
      openingLastAnswer: String(ready.answer || ''),
      openingChangedAt: Date.now(),
      openingDone: false,
      openingUncertain: false,
      openingCommand: {
        id: Number(command.id),
        prompt,
        baselineQueryCount,
        phase: 'claimed',
        failureDetail: '',
      },
    };
    saveRecovery();
    let sent;
    try {
      conversation.openingCommand.phase = 'submit-started';
      saveRecovery();
      sent = await sendNativeText(prompt, {allowConversationNavigation: true});
      if (sent.navigationAccepted) {
        sent = await verifySubmittedQuery(prompt, {baselineQueryCount, requireConversationUrl: true});
      }
      conversation.openingCommand.phase = 'sent-awaiting-result';
      if (sent.url) conversation.pageUrl = String(sent.url);
      saveRecovery();
    } catch (error) {
      const detail = String(error.message).slice(0, 300);
      conversation.openingCommand.failureDetail = detail;
      if (error.uncertain) {
        try {
          sent = await verifySubmittedQuery(prompt, {baselineQueryCount, requireConversationUrl: true});
          conversation.openingCommand.phase = 'sent-awaiting-result';
          conversation.openingUncertain = false;
          if (sent.url) conversation.pageUrl = String(sent.url);
          saveRecovery();
        } catch (verifyError) {
          conversation.openingUncertain = true;
          conversation.openingCommand.phase = 'send-uncertain';
          conversation.openingCommand.failureDetail = String(verifyError.message).slice(0, 300);
          saveRecovery();
          return {defer: true, conversation_id: id, detail: conversation.openingCommand.failureDetail};
        }
      } else {
        conversation.openingCommand.phase = 'send-failed';
        saveRecovery();
        conversation = null;
        clearRecovery();
        return {ok: false, conversation_id: id, detail};
      }
    }
    try {
      await publish(sent);
    } catch (error) {
      console.warn('Native Perplexity Dispatch publish after verified send:', error.message);
    }
    saveRecovery();
    return {ok: true, conversation_id: id, detail: 'Opening prompt sent; ' + (sent.model || 'GLM 5.3 Thinking verified')};
  }

  async function closeConversation(command) {
    if (!conversation || conversation.id !== command.conversation_id) {
      return {ok: false, detail: 'No native Perplexity conversation has this id'};
    }
    conversation = null;
    clearRecovery();
    if (agentView && !agentView.webContents.isDestroyed()) agentView.webContents.loadURL(HOME);
    return {ok: true, conversation_id: command.conversation_id, detail: 'Native Perplexity conversation released'};
  }

  async function loadRecoveryPage() {
    await ensureReady();
    if (conversation && isConversationUrl(conversation.pageUrl) && agentView.webContents.getURL() !== conversation.pageUrl) {
      await agentView.webContents.loadURL(conversation.pageUrl);
    }
    const deadline = Date.now() + 20000;
    let page = null;
    while (Date.now() < deadline) {
      try {
        page = await pageRequest('state', {}, 5000);
        if (page.ready) return page;
      } catch {
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (page) return page;
    throw new Error('Recovered Perplexity page is not ready');
  }

  async function recoverOpening(page) {
    if (!conversation || !conversation.openingCommand) return true;
    const opening = conversation.openingCommand;
    let sent = page;

    if (opening.phase === 'claimed') {
      try {
        opening.phase = 'submit-started';
        saveRecovery();
        sent = await sendNativeText(opening.prompt, {allowConversationNavigation: true});
        if (sent.navigationAccepted) {
          sent = await verifySubmittedQuery(opening.prompt, {
            baselineQueryCount: Number(opening.baselineQueryCount || 0),
            requireConversationUrl: true,
          });
        }
        opening.phase = 'sent-awaiting-result';
        conversation.openingUncertain = false;
        if (sent.url) conversation.pageUrl = String(sent.url);
        saveRecovery();
      } catch (error) {
        opening.failureDetail = String(error.message).slice(0, 300);
        if (!error.uncertain) {
          opening.phase = 'send-failed';
          saveRecovery();
        }
      }
    }

    if (opening.phase === 'submit-started' || opening.phase === 'send-uncertain') {
      try {
        sent = await verifySubmittedQuery(opening.prompt, {
          baselineQueryCount: Number(opening.baselineQueryCount || 0),
          requireConversationUrl: true,
          timeoutMs: 5000,
        });
        opening.phase = 'sent-awaiting-result';
        conversation.openingUncertain = false;
        if (sent.url) conversation.pageUrl = String(sent.url);
        saveRecovery();
      } catch (error) {
        opening.phase = 'send-uncertain';
        opening.failureDetail = String(error.message).slice(0, 300);
        conversation.openingUncertain = true;
        saveRecovery();
        return false;
      }
    }

    if (opening.phase === 'send-failed') {
      await request('/api/chat-commands/' + opening.id + '/result', {
        ok: false,
        conversation_id: conversation.id,
        detail: opening.failureDetail || 'Perplexity send failed before recovery',
      });
      conversation = null;
      clearRecovery();
      return false;
    }

    if (opening.phase === 'sent-awaiting-result') {
      try {
        sent = await pageRequest('state', {}, 5000);
        await publish(sent);
      } catch (error) {
        console.warn('Native Perplexity Dispatch recovery publish:', error.message);
      }
      await request('/api/chat-commands/' + opening.id + '/result', {
        ok: true,
        conversation_id: conversation.id,
        detail: 'Recovered verified opening prompt without replay',
      });
      conversation.openingCommand = null;
      conversation.openingUncertain = false;
      saveRecovery();
    }
    return true;
  }

  async function recoverPendingDelivery() {
    if (!conversation || !conversation.pending) return true;
    const pending = conversation.pending;
    if (!pending.body) {
      pending.phase = 'send-uncertain';
      pending.failureDetail = 'Recovered follow-up is missing its body; no automatic replay was attempted';
      saveRecovery();
      return false;
    }

    if (pending.phase === 'claimed') {
      try {
        pending.phase = 'submit-started';
        saveRecovery();
        await sendNativeText(pending.body);
        pending.phase = 'sent-awaiting-ack';
        saveRecovery();
      } catch (error) {
        pending.failureDetail = String(error.message).slice(0, 300);
        if (!error.uncertain) {
          pending.phase = 'send-failed';
          saveRecovery();
        }
      }
    }

    if (pending.phase === 'submit-started' || pending.phase === 'send-uncertain') {
      try {
        await verifySubmittedQuery(pending.body, {
          baselineQueryCount: Number(pending.baselineQueryCount || 0),
          timeoutMs: 5000,
        });
        pending.phase = 'sent-awaiting-ack';
        saveRecovery();
      } catch (error) {
        pending.phase = 'send-uncertain';
        pending.failureDetail = String(error.message).slice(0, 300);
        saveRecovery();
        return false;
      }
    }
    if (pending.phase === 'reply-started') {
      await request('/api/chat-messages/' + pending.id + '/reply', {reply: String(pending.replyText || '').slice(0, 200000)});
      conversation.pending = null;
      saveRecovery();
      return true;
    }
    return reconcilePendingDelivery();
  }

  async function recoverState() {
    const stored = loadRecovery();
    if (!stored) return true;
    hydrateRecovery(stored);
    const page = await loadRecoveryPage();
    if (conversation.openingCommand && !await recoverOpening(page)) return false;
    if (!conversation) return true;
    if (conversation.pending && !await recoverPendingDelivery()) return false;
    if (!conversation) return true;
    try {
      await publish(await pageRequest('state', {}, 5000));
    } catch (error) {
      console.warn('Native Perplexity Dispatch recovered state publish:', error.message);
    }
    return true;
  }

  async function reportCommandResult(command, result) {
    if (result && result.defer) return;
    await request('/api/chat-commands/' + command.id + '/result', result);
    if (command.kind === 'open' && result && result.ok && conversation &&
        conversation.openingCommand && Number(conversation.openingCommand.id) === Number(command.id)) {
      conversation.openingCommand = null;
      conversation.openingUncertain = false;
      saveRecovery();
    }
  }

  async function controllerReady() {
    try {
      const value = await request('/api/chat-open-prompt?surface=perplexity&lane=sup-perplexity');
      return value.surface === SURFACE;
    } catch {
      return false;
    }
  }

  async function tick() {
    if (!recoveryReady || running) return;
    running = true;
    try {
      if (!await controllerReady()) return;
      if (conversation) {
        const claimed = await request('/api/chat-commands/next', {surface: SURFACE});
        const command = claimed.command;
        if (command) {
          if (command.surface !== SURFACE) throw new Error('Dispatch returned a command for a different surface');
          let result;
          if (command.kind === 'open') result = await openConversation(command);
          else if (command.kind === 'close') result = await closeConversation(command);
          else result = {ok: false, detail: 'PR2 accepts only open and close commands'};
          await reportCommandResult(command, result);
          return;
        }
        try {
          await monitor();
        } catch (error) {
          console.warn('Native Perplexity Dispatch monitor:', error.message);
        }
        return;
      }

      await ensureReady();
      const claimed = await request('/api/chat-commands/next', {surface: SURFACE});
      const command = claimed.command;
      if (!command) return;
      if (command.surface !== SURFACE) throw new Error('Dispatch returned a command for a different surface');

      let result;
      if (command.kind === 'open') result = await openConversation(command);
      else if (command.kind === 'close') result = await closeConversation(command);
      else result = {ok: false, detail: 'PR2 accepts only open and close commands'};
      await reportCommandResult(command, result);
    } catch (error) {
      console.warn('Native Perplexity Dispatch:', error.message);
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    recoveryReady = false;
    ipcMain.on('simplexity-native-dispatch-result', onPageResult);
    const attemptRecovery = async () => {
      if (recoveryReady || !timer) return;
      try {
        const resolved = await recoverState();
        if (!resolved) return;
        recoveryReady = true;
        tick();
      } catch (error) {
        console.warn('Native Perplexity Dispatch recovery:', error.message);
        setTimeout(attemptRecovery, 2000);
      }
    };
    timer = setInterval(tick, 2000);
    attemptRecovery();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    ipcMain.removeListener('simplexity-native-dispatch-result', onPageResult);
    for (const pending of pendingPage.values()) pending.reject(new Error('Native Perplexity Dispatch stopped'));
    pendingPage.clear();
    conversation = null;
    if (agentHostWindow && !agentHostWindow.isDestroyed()) agentHostWindow.destroy();
    agentHostWindow = null;
    agentView = null;
  }

  return {start, stop};
}

module.exports = {createNativeDispatch};