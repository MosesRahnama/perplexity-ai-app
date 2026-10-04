'use strict';

const BASE = 'http://127.0.0.1:8792';
const HOME = 'https://www.perplexity.ai/';
const SURFACE = 'perplexity';

function createNativeDispatch({BrowserWindow, BrowserView, ipcMain, shell, path, appDir}) {
  let agentView = null;
  let agentHostWindow = null;
  let timer = null;
  let running = false;
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

  function pageRequest(type, payload = {}, timeoutMs = 15000) {
    if (!agentView || agentView.webContents.isDestroyed()) {
      return Promise.reject(new Error('Native Perplexity Agent BrowserView is unavailable'));
    }
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timerId = setTimeout(() => {
        pendingPage.delete(id);
        const error = new Error('Perplexity page did not answer ' + type);
        error.uncertain = type === 'send';
        reject(error);
      }, timeoutMs);
      pendingPage.set(id, {
        resolve: (value) => { clearTimeout(timerId); resolve(value); },
        reject: (error) => { clearTimeout(timerId); reject(error); },
      });
      try {
        agentView.webContents.send('simplexity-native-dispatch-command', {requestId: id, type, payload});
      } catch (error) {
        clearTimeout(timerId);
        pendingPage.delete(id);
        error.uncertain = type === 'send';
        reject(error);
      }
    });
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
        return true;
      } catch {
        return false;
      }
    }
    if (pending.phase === 'sent-awaiting-ack') {
      try {
        await request('/api/chat-messages/' + pending.id + '/delivered', {ok: true, detail: ''});
        pending.phase = 'delivered';
      } catch {
        return false;
      }
    }
    return pending.phase === 'delivered';
  }

  async function finishFollowup(page) {
    const pending = conversation && conversation.pending;
    if (!pending || pending.phase !== 'delivered') return;
    const answer = String(page.answer || '');
    if (answer !== pending.lastAnswer) {
      pending.lastAnswer = answer;
      pending.changedAt = Date.now();
    }
    if (!answer || answer === pending.baselineAnswer || page.busy || page.needsApproval ||
        page.connectionError || Date.now() - pending.changedAt < 8000) return;
    await request('/api/chat-messages/' + pending.id + '/reply', {reply: answer.slice(0, 200000)});
    conversation.pending = null;
  }

  async function maybeSendFollowup(page) {
    if (!conversation || !conversation.openingDone || conversation.pending || page.busy ||
        page.needsApproval || page.connectionError || !page.ready) return;
    const claimed = await request('/api/chats/' + encodeURIComponent(conversation.id) + '/next', {});
    const message = claimed.message;
    if (!message) return;

    const baselineAnswer = String(page.answer || '');
    conversation.pending = {
      id: Number(message.id),
      baselineAnswer,
      lastAnswer: baselineAnswer,
      changedAt: Date.now(),
      phase: 'sending',
      failureDetail: '',
    };
    try {
      await pageRequest('send', {text: String(message.body || '')}, 35000);
      conversation.pending.phase = 'sent-awaiting-ack';
    } catch (error) {
      conversation.pending.failureDetail = String(error.message).slice(0, 300);
      if (error.uncertain) {
        conversation.pending.phase = 'send-uncertain';
        return;
      }
      conversation.pending.phase = 'send-failed';
    }
    await reconcilePendingDelivery();
  }

  async function monitor() {
    if (!conversation || !agentView || agentView.webContents.isDestroyed()) return;
    if (!isPerplexityUrl(agentView.webContents.getURL())) return;
    const page = await pageRequest('state', {}, 5000);
    await publish(page);
    if (conversation.openingUncertain) return;
    await finishOpening(page);
    if (!await reconcilePendingDelivery()) return;
    await finishFollowup(page);
    await maybeSendFollowup(page);
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
    conversation = {
      id,
      lane: String(command.lane || 'sup-perplexity').slice(0, 100),
      model: 'glm-5.3',
      reasoning: 'thinking',
      pending: null,
      lastTranscript: '',
      openingBaseline: String(ready.answer || ''),
      openingLastAnswer: String(ready.answer || ''),
      openingChangedAt: Date.now(),
      openingDone: false,
    };
    let sent;
    try {
      sent = await pageRequest('send', {text: String(command.prompt || '')}, 35000);
    } catch (error) {
      const detail = String(error.message).slice(0, 300);
      if (error.uncertain) {
        conversation.openingUncertain = true;
        return {ok: false, conversation_id: id, detail};
      }
      conversation = null;
      return {ok: false, conversation_id: id, detail};
    }
    try {
      await publish(sent);
    } catch (error) {
      console.warn('Native Perplexity Dispatch publish after verified send:', error.message);
    }
    return {ok: true, conversation_id: id, detail: 'Opening prompt sent; ' + (sent.model || 'GLM 5.3 Thinking verified')};
  }

  async function closeConversation(command) {
    if (!conversation || conversation.id !== command.conversation_id) {
      return {ok: false, detail: 'No native Perplexity conversation has this id'};
    }
    conversation = null;
    if (agentView && !agentView.webContents.isDestroyed()) agentView.webContents.loadURL(HOME);
    return {ok: true, conversation_id: command.conversation_id, detail: 'Native Perplexity conversation released'};
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
    if (running) return;
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
          await request('/api/chat-commands/' + command.id + '/result', result);
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
      await request('/api/chat-commands/' + command.id + '/result', result);
    } catch (error) {
      console.warn('Native Perplexity Dispatch:', error.message);
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    ipcMain.on('simplexity-native-dispatch-result', onPageResult);
    tick();
    timer = setInterval(tick, 2000);
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