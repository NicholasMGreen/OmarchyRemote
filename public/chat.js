// Chat: conversations with a local agent (Claude Code) that need no project. The host keeps each
// conversation as a Markdown file in ~/Chats; this view lists them and streams replies.
(() => {
  const { node, button, storage } = window.HyprlandUtil;
  const headers = { 'X-Hyprland-Client': '1', 'Content-Type': 'application/json' };
  const OPEN = 'omarchy-chat-open';
  // The model and effort chosen last; new chats start with them.
  const SETTINGS = 'omarchy-chat-settings';

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
  const ICONS = {
    compose: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z',
    back: 'm15 18-6-6 6-6',
    stop: 'M6 6h12v12H6Z',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
    tool: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4Z',
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }
  function iconButton(name, label, fn, className) {
    const b = button('', fn, 'chat-icon-button ' + className);
    b.setAttribute('aria-label', label);
    b.title = label;
    b.append(icon(name));
    return b;
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
      this.heading = node('h2', 'chat-heading', 'Chats');
      this.selectButton = button('Select', () => this.select(true), 'chat-text-button');
      this.cancelSelect = button('Cancel', () => this.select(false), 'chat-text-button');
      this.cancelSelect.hidden = true;
      this.newButton = iconButton('compose', 'New chat', () => this.startNew(), 'chat-new');
      listBar.append(this.heading, this.selectButton, this.cancelSelect, this.newButton);
      // Selecting several chats offers Archive and Delete; Delete asks to confirm first.
      this.selected = new Set();
      this.actions = node('div', 'chat-actions');
      this.actions.hidden = true;
      this.actionText = node('span', 'chat-actions-text');
      this.archiveButton = button('Archive', () => this.archive(), 'remote-button');
      this.deleteButton = button(
        'Delete',
        () => this.confirmDelete(true),
        'remote-button chat-danger'
      );
      this.keepButton = button('Keep', () => this.confirmDelete(false), 'remote-button');
      this.confirmButton = button('Delete', () => this.remove(), 'remote-button chat-danger');
      this.confirmButton.setAttribute('aria-label', 'Delete permanently');
      this.actions.append(
        this.actionText,
        this.archiveButton,
        this.deleteButton,
        this.keepButton,
        this.confirmButton
      );
      this.list = node('div', 'chat-list');
      this.list.setAttribute('role', 'list');
      this.empty = node('div', 'chat-list-empty');
      this.empty.append(
        node('span', 'chat-list-empty-icon', '\uf086'),
        node('p', 'chat-list-empty-title', 'No chats yet'),
        node('p', 'chat-list-empty-text', 'Ask Claude anything. No project needed.'),
        button('Start a chat', () => this.startNew(), 'remote-button chat-start')
      );
      this.empty.hidden = true;
      this.listStatus = node('p', 'remote-status chat-folder');
      this.listView.append(listBar, this.list, this.empty, this.actions, this.listStatus);

      this.threadView = node('section', 'chat-thread-view');
      this.threadView.hidden = true;
      const threadBar = node('div', 'chat-bar');
      this.backButton = iconButton('back', 'All chats', () => this.showList(), 'chat-back');
      this.title = node('h2', 'chat-title');
      this.stopButton = iconButton('stop', 'Stop', () => this.stop(), 'chat-stop');
      this.stopButton.hidden = true;
      this.threadNew = iconButton('compose', 'New chat', () => this.startNew(), 'chat-new');
      // Each chat is a folder; files Claude makes for it land there.
      this.folderButton = iconButton(
        'folder',
        'Open chat folder',
        () => this.openFolder(),
        'chat-folder-button'
      );
      this.settingsButton = button('', () => this.toggleSettings(), 'chat-settings');
      this.settingsButton.setAttribute('aria-expanded', 'false');
      threadBar.append(
        this.backButton,
        this.title,
        this.settingsButton,
        this.folderButton,
        this.stopButton,
        this.threadNew
      );
      this.settingsPanel = node('div', 'chat-settings-panel');
      this.settingsPanel.hidden = true;
      this.options = { models: [], efforts: [], defaults: {} };
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
      this.threadView.append(
        threadBar,
        this.settingsPanel,
        this.messages,
        this.status,
        this.promptRow
      );
      root.append(this.listView, this.threadView);
      // The shell gives the composer focus only while this detail view is showing.
      this.detail = this.threadView;

      this.nativeInput = bridge.createInput(this.threadView, true, text => this.send(text), {
        compactControls: true,
        draftStore: 'omarchy-chat-drafts-v1',
      });
      // Chat is always a message: no terminal keys, and tapping the conversation hides the
      // keyboard, so the composer needs no header row.
      this.nativeInput.header.hidden = true;
      this.messages.addEventListener('click', e => {
        if (
          window.__HYPRLAND_HARDWARE_KEYBOARD__ === true ||
          this.nativeInput.element.hidden ||
          e.target.closest('a, button') ||
          !getSelection().isCollapsed
        )
          return;
        this.nativeInput.dismiss();
      });
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
      if (e.type === 'removed') {
        for (const id of e.ids) this.selected.delete(id);
        if (this.chat?.id && e.ids.includes(this.chat.id)) this.showList();
        return;
      }
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
        this.options = {
          models: data.models || [],
          efforts: data.efforts || [],
          defaults: data.defaults || {},
        };
        this.renderSettings();
        this.renderList();
      } catch (e) {
        this.listStatus.textContent = e.message;
      }
    }
    renderList() {
      this.list.replaceChildren(
        ...this.chats.map(chat => {
          const selecting = this.selecting;
          const row = button(
            '',
            () => (selecting ? this.toggle(chat.id) : this.open(chat.id)),
            'chat-row'
          );
          row.setAttribute('role', selecting ? 'checkbox' : 'listitem');
          if (selecting) {
            const checked = this.selected.has(chat.id);
            row.setAttribute('aria-checked', String(checked));
            row.classList.toggle('selected', checked);
            row.append(node('span', 'chat-check'));
          }
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
      this.empty.hidden = !!this.chats.length || this.available === false;
      this.listStatus.textContent =
        this.available === false
          ? `Claude Code is not installed on ${HyprlandApps.host.name}.`
          : this.listError || `Saved in ${this.folder || '~/Chats'}`;
      this.listStatus.classList.toggle('error', !!this.listError);
      this.newButton.disabled = this.available === false;
      this.selectButton.hidden = this.selecting || !this.chats.length;
      this.renderActions();
    }
    select(on) {
      if (on) this.listError = '';
      this.selecting = on;
      this.selected.clear();
      this.confirming = false;
      this.renderList();
    }
    toggle(id) {
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
      this.confirming = false;
      this.renderList();
    }
    confirmDelete(on) {
      this.confirming = on;
      this.renderActions();
    }
    renderActions() {
      const count = this.selected.size;
      const chats = count === 1 ? 'chat' : 'chats';
      this.heading.textContent = this.selecting ? `${count} selected` : 'Chats';
      this.cancelSelect.hidden = !this.selecting;
      this.newButton.hidden = !!this.selecting;
      this.actions.hidden = !this.selecting;
      this.actions.classList.toggle('confirming', !!this.confirming);
      this.actionText.textContent = this.confirming
        ? `Delete ${count} ${chats} permanently?`
        : count
          ? ''
          : 'Select chats';
      this.archiveButton.hidden = this.deleteButton.hidden = !!this.confirming;
      this.keepButton.hidden = this.confirmButton.hidden = !this.confirming;
      this.archiveButton.disabled = this.deleteButton.disabled = !count || this.working;
      this.confirmButton.disabled = this.working;
    }
    archive() {
      return this.manage('archive');
    }
    remove() {
      return this.manage('delete');
    }
    async manage(action) {
      const ids = [...this.selected];
      if (!ids.length) return;
      this.working = true;
      this.renderActions();
      try {
        const result = await request('/' + action, { ids });
        this.select(false);
        this.listError = result.failed.length
          ? `Could not ${action} ${result.failed.length}: ${result.failed[0].error}`
          : '';
      } catch (e) {
        this.listError = e.message;
      } finally {
        this.working = false;
        this.renderActions();
        this.refresh();
      }
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
      this.toggleSettings(false);
      this.renderSettings();
      this.listView.hidden = true;
      this.threadView.hidden = false;
      this.nativeInput.select(this.chat.id || 'new');
      this.nativeInput.field.placeholder = 'Message Claude…';
      this.following = true;
      this.render();
    }
    startNew() {
      const settings = storage.read(SETTINGS, {}) || {};
      this.chat = {
        id: null,
        title: 'New chat',
        entries: [],
        partial: '',
        seq: 0,
        busy: false,
        model: typeof settings.model === 'string' ? settings.model : '',
        effort: typeof settings.effort === 'string' ? settings.effort : '',
      };
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
      request('/send', {
        id: chat.id,
        text,
        model: chat.model || '',
        effort: chat.effort || '',
      })
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
    // Model and effort apply from the next message; the host restarts the chat's agent for them.
    toggleSettings(open = this.settingsPanel.hidden) {
      this.settingsPanel.hidden = !open;
      this.settingsButton.setAttribute('aria-expanded', String(open));
      if (open) this.renderSettings();
    }
    choose(key, value) {
      if (!this.chat) return;
      this.chat[key] = value;
      storage.write(SETTINGS, { model: this.chat.model || '', effort: this.chat.effort || '' });
      this.renderSettings();
    }
    renderSettings() {
      const chat = this.chat;
      if (!chat) return;
      const { models, efforts, defaults } = this.options;
      const short = model => String(model || '').replace(/^claude-/, '');
      const model = models.find(m => m.id === chat.model)?.label || chat.model;
      this.settingsButton.textContent = `${model || short(defaults.model) || 'Default'} · ${
        chat.effort || defaults.effort || 'default'
      }`;
      this.settingsButton.setAttribute(
        'aria-label',
        'Model and effort: ' + this.settingsButton.textContent
      );
      if (this.settingsPanel.hidden) return;
      const group = (label, key, choices) => {
        const row = node('div', 'chat-settings-row');
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', label);
        row.append(node('span', 'chat-settings-label', label));
        for (const [value, text] of choices) {
          const option = button(text, () => this.choose(key, value), 'chat-option');
          option.setAttribute('aria-pressed', String((chat[key] || '') === value));
          row.append(option);
        }
        return row;
      };
      this.settingsPanel.replaceChildren(
        group('Model', 'model', [
          ['', defaults.model ? `Default (${short(defaults.model)})` : 'Default'],
          ...models.map(m => [m.id, m.label]),
        ]),
        group('Effort', 'effort', [
          ['', defaults.effort ? `Default (${defaults.effort})` : 'Default'],
          ...efforts.map(e => [e, e]),
        ]),
        node(
          'p',
          'chat-settings-note',
          chat.id ? 'Changes apply from your next message.' : 'Applies to this new chat.'
        )
      );
    }
    openFolder() {
      const files = HyprlandApps.get('files')?.provider;
      if (this.chat?.folder && files?.openAt) files.openAt(this.bridge, this.chat.folder);
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
        tool.append(icon('tool'), node('b', '', entry.name));
        if (entry.text) tool.append(' ', node('span', '', entry.text));
        tool.title = entry.text ? `${entry.name}: ${entry.text}` : entry.name;
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
      this.folderButton.hidden = !chat?.folder || !HyprlandApps.get('files')?.provider?.openAt;
      this.status.classList.toggle('error', !!chat?.error);
      this.status.classList.toggle('thinking', !chat?.error && !!chat?.busy && !chat.partial);
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
