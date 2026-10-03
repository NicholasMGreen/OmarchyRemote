// Chat: conversations with a local agent (Claude Code) that need no project. The host keeps each
// conversation as a Markdown file in ~/Chats; this view lists them and streams replies.
(() => {
  const { node, button, storage } = window.HyprlandUtil;
  const headers = { 'X-Hyprland-Client': '1', 'Content-Type': 'application/json' };
  const OPEN = 'omarchy-chat-open';

  async function request(path, body) {
    const response = await fetch(
      '/api/chat' + path,
      body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || 'The host did not respond.');
    return data;
  }
  // Replies are Markdown. DOMPurify removes anything that could run in the shell's page.
  function markdown(target, text) {
    if (!window.marked || !window.DOMPurify) {
      target.textContent = text;
      return;
    }
    target.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true }));
    for (const link of target.querySelectorAll('a[href]')) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }
  function ago(time) {
    const seconds = (Date.now() - Date.parse(time)) / 1000;
    if (!Number.isFinite(seconds)) return '';
    if (seconds < 60) return 'now';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h';
    return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  class ChatApp {
    constructor(root, bridge) {
      this.root = root;
      this.bridge = bridge;
      root.classList.add('chat-app');
      this.chat = null;
      this.chats = [];

      this.listView = node('section', 'chat-list-view');
      const listBar = node('div', 'chat-bar');
      listBar.append(node('h2', 'chat-heading', 'Chats'));
      this.newButton = button('New chat', () => this.startNew(), 'remote-button chat-new');
      listBar.append(this.newButton);
      this.list = node('div', 'chat-list');
      this.list.setAttribute('role', 'list');
      this.listStatus = node('p', 'remote-status chat-folder');
      this.listView.append(listBar, this.list, this.listStatus);

      this.threadView = node('section', 'chat-thread-view');
      this.threadView.hidden = true;
      const threadBar = node('div', 'chat-bar');
      this.backButton = button('‹', () => this.showList(), 'remote-button chat-back');
      this.backButton.setAttribute('aria-label', 'All chats');
      this.title = node('h2', 'chat-title');
      this.stopButton = button('Stop', () => this.stop(), 'remote-button chat-stop');
      this.stopButton.hidden = true;
      threadBar.append(this.backButton, this.title, this.stopButton);
      this.messages = node('div', 'chat-messages');
      this.messages.setAttribute('role', 'log');
      this.messages.setAttribute('aria-live', 'polite');
      this.status = node('p', 'remote-status chat-status');
      this.status.setAttribute('role', 'status');
      this.promptRow = node('div', 'herdr-prompt-row chat-prompt-row');
      this.promptField = button('', () => bridge.keyboard());
      this.promptField.className = 'prompt-field herdr-prompt chat-prompt';
      this.promptField.setAttribute('aria-label', 'Write a message');
      this.promptField.append(node('span', 'chat-placeholder', 'Message Claude…'));
      this.promptRow.append(this.promptField);
      this.threadView.append(threadBar, this.messages, this.status, this.promptRow);
      root.append(this.listView, this.threadView);
      // The shell gives the composer focus only while this detail view is showing.
      this.detail = this.threadView;

      this.nativeInput = bridge.createInput(this.threadView, true, text => this.send(text), {
        compactControls: true,
        draftStore: 'omarchy-chat-drafts-v1',
      });
      // Chat is always a message; there is no terminal to send keys to.
      this.nativeInput.mode.hidden = true;
      this.messages.onscroll = () => {
        this.following =
          this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 80;
      };
    }
    connect() {
      this.socket();
      this.refresh();
      const open = storage.get(OPEN);
      if (open) this.open(open);
    }
    resume() {
      if (!this.ws || this.ws.readyState > 1) this.socket();
      this.refresh();
      if (this.chat?.id) this.open(this.chat.id);
    }
    socket() {
      clearTimeout(this.retry);
      const ws = new WebSocket(
        (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/chat/ws'
      );
      this.ws = ws;
      ws.onmessage = e => this.event(JSON.parse(e.data));
      ws.onclose = () => {
        if (this.disposed || this.ws !== ws) return;
        this.retry = setTimeout(() => {
          this.socket();
          if (this.chat?.id) this.open(this.chat.id);
        }, 2000);
      };
    }
    event(e) {
      if (e.type === 'resync') {
        if (this.chat?.id) this.open(this.chat.id);
        return;
      }
      if (e.type !== 'delta') this.listChanged();
      // While a chat loads, its events wait so none is lost or applied twice.
      if (this.buffer) {
        this.buffer.push(e);
        return;
      }
      this.apply(e);
    }
    apply(e) {
      if (!this.chat || e.id !== this.chat.id || e.n <= this.chat.n) return;
      this.chat.n = e.n;
      if (e.type === 'entry') {
        this.chat.entries[e.index] = e.entry;
        if (e.entry.role === 'assistant') this.chat.partial = '';
        this.render();
      } else if (e.type === 'delta' && e.seq > this.chat.seq) {
        this.chat.seq = e.seq;
        this.chat.partial += e.text;
        this.renderPartial();
      } else if (e.type === 'busy') {
        this.chat.busy = true;
        this.chat.error = null;
        this.renderState();
      } else if (e.type === 'done') {
        this.chat.busy = false;
        this.chat.partial = '';
        this.chat.error = e.error;
        this.render();
      }
    }
    listChanged() {
      clearTimeout(this.listTimer);
      this.listTimer = setTimeout(() => this.refresh(), 400);
    }
    async refresh() {
      try {
        const data = await request('');
        this.chats = data.chats;
        this.folder = data.folder;
        this.available = data.available;
        this.renderList();
      } catch (e) {
        this.listStatus.textContent = e.message;
      }
    }
    renderList() {
      this.list.replaceChildren(
        ...this.chats.map(chat => {
          const row = button('', () => this.open(chat.id), 'chat-row');
          row.setAttribute('role', 'listitem');
          const top = node('span', 'chat-row-top');
          top.append(
            node('span', 'chat-row-title', chat.title),
            node('time', '', ago(chat.updated))
          );
          row.append(top, node('span', 'chat-row-preview', chat.preview || ''));
          if (chat.busy) row.classList.add('busy');
          return row;
        })
      );
      if (!this.available)
        this.listStatus.textContent = `Claude Code is not installed on ${HyprlandApps.host.name}.`;
      else if (!this.chats.length)
        this.listStatus.textContent = `No chats yet. They are saved in ${this.folder || '~/Chats'}.`;
      else this.listStatus.textContent = `Saved in ${this.folder}`;
      this.newButton.disabled = this.available === false;
    }
    showList() {
      this.chat = null;
      storage.set(OPEN, null);
      this.nativeInput.dismiss();
      this.threadView.hidden = true;
      this.listView.hidden = false;
      this.refresh();
    }
    showThread() {
      this.listView.hidden = true;
      this.threadView.hidden = false;
      this.nativeInput.select(this.chat.id || 'new');
      this.following = true;
      this.render();
    }
    startNew() {
      this.chat = { id: null, title: 'New chat', entries: [], partial: '', seq: 0, busy: false };
      storage.set(OPEN, null);
      this.showThread();
      this.bridge.keyboard();
    }
    async open(id) {
      const opening = (this.opening = id);
      this.buffer ||= [];
      try {
        const chat = await request('/' + encodeURIComponent(id));
        if (this.opening !== opening) return;
        this.chat = { ...chat, error: null };
        storage.set(OPEN, id);
        this.showThread();
        // The loaded state includes events up to its number; apply only later ones.
        const buffered = this.buffer;
        this.buffer = null;
        for (const e of buffered) this.apply(e);
      } catch (e) {
        if (this.opening !== opening) return;
        this.buffer = null;
        storage.set(OPEN, null);
        if (this.chat?.id === id) this.status.textContent = e.message;
      }
    }
    send(text) {
      text = text.trim();
      if (!text || !this.chat) return false;
      const chat = this.chat;
      const draft = chat.id || 'new';
      if (!chat.id) {
        // Events for the new chat arrive before its id does; hold them until it opens.
        this.buffer = [];
        chat.title = text.split('\n')[0];
        chat.entries.push({ role: 'user', text, time: new Date().toISOString() });
        chat.busy = true;
        this.render();
      }
      request('/send', { id: chat.id, text })
        .then(({ id }) => {
          // A new chat learns its id here; its state so far comes from the host.
          if (!chat.id && this.chat === chat) this.open(id);
        })
        .catch(e => {
          if (!chat.id) this.buffer = null;
          // Keep the message as a draft so nothing typed is lost.
          const input = this.nativeInput;
          if (input.id === draft) {
            input.draft = text;
            input.configure();
          }
          input.storeDraft(draft, text);
          if (this.chat === chat) {
            if (!chat.id) chat.entries.pop();
            chat.busy = false;
            chat.error = e.message;
            this.render();
          }
        });
    }
    async stop() {
      if (!this.chat?.id) return;
      this.stopButton.disabled = true;
      try {
        await request(`/${encodeURIComponent(this.chat.id)}/stop`, {});
      } catch (e) {
        this.status.textContent = e.message;
      } finally {
        this.stopButton.disabled = false;
      }
    }
    render() {
      const chat = this.chat;
      if (!chat) return;
      this.title.textContent = chat.title || 'New chat';
      const nodes = chat.entries.filter(Boolean).map(entry => this.entry(entry));
      if (!nodes.length)
        nodes.push(
          node('p', 'chat-empty', `Ask anything. Claude runs on ${HyprlandApps.host.name}.`)
        );
      this.partialNode = node('div', 'chat-message assistant streaming');
      this.partialNode.hidden = true;
      this.messages.replaceChildren(...nodes, this.partialNode);
      this.renderPartial();
      this.renderState();
    }
    entry(entry) {
      if (entry.role === 'tool') {
        const tool = node('p', 'chat-tool');
        tool.append(node('b', '', entry.name));
        if (entry.text) tool.append(' ' + entry.text);
        return tool;
      }
      const message = node('div', 'chat-message ' + entry.role);
      if (entry.role === 'assistant') markdown(message, entry.text);
      else message.textContent = entry.text;
      return message;
    }
    renderPartial() {
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => {
        const text = this.chat?.partial || '';
        this.partialNode.hidden = !text;
        if (text) markdown(this.partialNode, text);
        this.scroll();
      });
    }
    renderState() {
      const chat = this.chat;
      this.stopButton.hidden = !chat?.busy || !chat.id;
      this.status.classList.toggle('error', !!chat?.error);
      this.status.textContent = chat?.error
        ? chat.error
        : chat?.busy && !chat.partial
          ? 'Claude is thinking…'
          : '';
      this.scroll();
    }
    scroll() {
      if (this.following !== false) this.messages.scrollTop = this.messages.scrollHeight;
    }
    key() {}
    show(visible) {
      if (visible && this.chat) this.renderState();
    }
    placeLatest() {
      this.promptRow.hidden = !this.nativeInput.element.hidden;
    }
    dispose() {
      this.disposed = true;
      clearTimeout(this.retry);
      clearTimeout(this.listTimer);
      this.ws?.close();
      this.nativeInput.dispose();
    }
  }
  window.HyprlandApps?.provide('chat', {
    create: (root, bridge) => new ChatApp(root, bridge),
  });
})();
