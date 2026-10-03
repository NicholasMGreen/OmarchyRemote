import { test, expect } from './fixtures.mjs';

const ID = '1b8ab544-8cc5-430e-8a40-0aec58bc3b10';
const NEW = '2c8ab544-8cc5-430e-8a40-0aec58bc3b10';
const entry = (role, text, name = '') => ({ role, text, name, time: '2026-10-03T10:00:00Z' });

async function setup(page) {
  await page.setViewportSize({ width: 402, height: 874 });
  const state = {
    chats: [
      {
        id: ID,
        title: 'Dinner ideas',
        preview: 'Pasta is quick.',
        updated: new Date().toISOString(),
        busy: false,
      },
    ],
    conversations: {
      [ID]: {
        id: ID,
        title: 'Dinner ideas',
        entries: [entry('user', 'Ideas for dinner?'), entry('assistant', '**Pasta** is quick.')],
        busy: false,
        partial: '',
        seq: 0,
        n: 0,
      },
    },
    sent: [],
    stopped: [],
    failSend: false,
    n: 0,
  };
  await page.route('**/api/**', r => r.abort());
  await page.route('**/api/chat', r =>
    r.fulfill({ json: { folder: '~/Chats', available: true, agent: 'claude', chats: state.chats } })
  );
  await page.route('**/api/chat/send', async r => {
    const body = r.request().postDataJSON();
    state.sent.push(body);
    if (state.failSend)
      return r.fulfill({ status: 502, json: { error: 'Claude could not start' } });
    const id = body.id || NEW;
    if (!body.id)
      state.conversations[NEW] = {
        id: NEW,
        title: body.text,
        entries: [entry('user', body.text)],
        busy: true,
        partial: '',
        seq: 0,
        n: state.n,
      };
    await r.fulfill({ json: { id } });
  });
  await page.route(/\/api\/chat\/[0-9a-f-]{36}$/, r => {
    const id = r.request().url().split('/').pop();
    return r.fulfill({ json: state.conversations[id] });
  });
  await page.route(/\/api\/chat\/[0-9a-f-]{36}\/stop$/, r => {
    state.stopped.push(r.request().url().split('/').at(-2));
    return r.fulfill({ json: { stopped: true } });
  });
  await page.routeWebSocket('**/api/chat/ws', ws => {
    state.ws = ws;
  });
  await page.goto('/native/');
  await page.getByText('chat', { exact: true }).first().click();
  const app = page.locator('#remote-chat-app');
  await expect(app).toBeVisible();
  // Numbered like the host's events.
  const emit = event => state.ws.send(JSON.stringify({ ...event, n: ++state.n }));
  return { app, state, emit };
}

test('the list shows saved chats and opens one with its Markdown reply', async ({ page }) => {
  const { app } = await setup(page);
  await expect(app.locator('.chat-row')).toHaveCount(1);
  await expect(app.locator('.chat-row-title')).toHaveText('Dinner ideas');
  await expect(app.locator('.chat-folder')).toHaveText('Saved in ~/Chats');
  await app.locator('.chat-row').click();
  await expect(app.locator('.chat-title')).toHaveText('Dinner ideas');
  await expect(app.locator('.chat-message.user')).toHaveText('Ideas for dinner?');
  await expect(app.locator('.chat-message.assistant strong')).toHaveText('Pasta');
  // The open chat comes back after a reload; the shell also reopens the app.
  await page.reload();
  await expect(app.locator('.chat-title')).toHaveText('Dinner ideas');
  await app.getByRole('button', { name: 'All chats' }).click();
  await expect(app.locator('.chat-row')).toHaveCount(1);
});

test('a new chat streams its reply, shows tools, and can be stopped', async ({ page }) => {
  const { app, state, emit } = await setup(page);
  await app.getByRole('button', { name: 'New chat' }).click();
  await expect(app.locator('.chat-empty')).toContainText('Ask anything');
  const field = app.locator('textarea.native-input');
  await field.fill('What is a pelican?');
  await field.press('Enter');
  await expect.poll(() => state.sent).toEqual([{ id: null, text: 'What is a pelican?' }]);
  // The tool event can arrive before the new chat has loaded; it still appears once.
  await expect(app.locator('.chat-title')).toHaveText('What is a pelican?');
  await expect(app.locator('.chat-message.user')).toHaveText('What is a pelican?');
  await expect(app.locator('.chat-status')).toHaveText('Claude is thinking…');
  emit({ type: 'entry', id: NEW, index: 1, entry: entry('tool', 'pelican facts', 'WebSearch') });
  await expect(app.locator('.chat-tool')).toHaveText('WebSearch pelican facts');
  emit({ type: 'delta', id: NEW, seq: 1, text: 'A **large** water' });
  emit({ type: 'delta', id: NEW, seq: 2, text: 'bird.' });
  // A delta it already has is ignored.
  emit({ type: 'delta', id: NEW, seq: 2, text: 'bird.' });
  await expect(app.locator('.chat-message.streaming')).toHaveText('A large waterbird.');
  await expect(app.locator('.chat-stop')).toBeVisible();
  await app.locator('.chat-stop').click();
  await expect.poll(() => state.stopped).toEqual([NEW]);
  emit({ type: 'entry', id: NEW, index: 2, entry: entry('assistant', 'A **large** waterbird.') });
  emit({ type: 'done', id: NEW, error: null });
  await expect(app.locator('.chat-message.streaming')).toBeHidden();
  await expect(app.locator('.chat-message.assistant:not(.streaming) strong')).toHaveText('large');
  await expect(app.locator('.chat-stop')).toBeHidden();
  await expect(app.locator('.chat-status')).toBeHidden();
  // Events for other chats leave this one alone.
  emit({ type: 'delta', id: ID, seq: 1, text: 'elsewhere' });
  await expect(app.locator('.chat-message.streaming')).toBeHidden();
});

test('a failed send keeps the message as a draft and shows why', async ({ page }) => {
  const { app, state } = await setup(page);
  state.failSend = true;
  await app.locator('.chat-row').click();
  const field = app.locator('textarea.native-input');
  await app.getByRole('button', { name: 'Write a message' }).click();
  await field.fill('Keep this text');
  await field.press('Enter');
  await expect(app.locator('.chat-status')).toHaveText('Claude could not start');
  await expect(field).toHaveValue('Keep this text');
});

test('replies cannot run script and their links leave the app', async ({ page }) => {
  const { app, emit } = await setup(page);
  await app.locator('.chat-row').click();
  await expect(app.locator('.chat-message.assistant:not(.streaming)')).toHaveCount(1);
  emit({
    type: 'entry',
    id: ID,
    index: 2,
    entry: entry(
      'assistant',
      'See [docs](https://example.com).\n\n<img src=x onerror="window.chatInjected=1"><script>window.chatInjected=2</script>'
    ),
  });
  const link = app.locator('.chat-message.assistant:not(.streaming) a');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.chatInjected)).toBeUndefined();
  expect(await app.locator('.chat-message.assistant [onerror], .chat-message script').count()).toBe(
    0
  );
});

test('tapping the message box types and tapping the conversation hides the keyboard', async ({
  page,
}) => {
  const { app, emit } = await setup(page);
  await app.locator('.chat-row').click();
  emit({ type: 'entry', id: 'x', index: 0, entry: entry('user', 'ignored') });
  emit({
    type: 'entry',
    id: ID,
    index: 2,
    entry: entry('tool', 'pelican facts and a long query that runs past the edge', 'WebSearch'),
  });
  await expect(app.locator('.chat-tool')).toBeVisible();
  const composer = app.locator('textarea.native-input');
  await expect(composer).toBeHidden();
  const font = locator => locator.evaluate(e => getComputedStyle(e).font);
  const standIn = await font(app.locator('.chat-prompt'));
  await app.getByRole('button', { name: 'Write a message' }).click();
  // The message box looks the same with the keyboard up or down.
  expect(await font(composer)).toBe(standIn);
  await expect(composer).toBeFocused();
  // The composer has no header row: no keyboard-dismiss or typing-mode button.
  await expect(app.getByRole('button', { name: 'Hide keyboard' })).toBeHidden();
  await expect(app.getByRole('button', { name: /mode/ })).toBeHidden();
  await page.screenshot({ path: 'artifacts/browser/chat-thread-keyboard.png' });
  await app.locator('.chat-message.assistant').first().click();
  await expect(composer).toBeHidden();
  await expect(app.getByRole('button', { name: 'Write a message' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/browser/chat-thread.png' });
});

test('an empty list invites a first chat', async ({ page }) => {
  const { app, state } = await setup(page);
  await page.unroute('**/api/chat');
  await page.route('**/api/chat', r =>
    r.fulfill({ json: { folder: '~/Chats', available: true, agent: 'claude', chats: [] } })
  );
  state.chats = [];
  await page.reload();
  await expect(app.getByRole('button', { name: 'Start a chat' })).toBeVisible();
  await expect(app.locator('.chat-folder')).toHaveText('Saved in ~/Chats');
  await page.screenshot({ path: 'artifacts/browser/chat-empty.png' });
  await app.getByRole('button', { name: 'Start a chat' }).click();
  await expect(app.locator('.chat-empty')).toContainText('Ask anything');
});
