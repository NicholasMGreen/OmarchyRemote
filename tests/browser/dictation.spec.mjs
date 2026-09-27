import { test, expect } from './fixtures.mjs';
async function setup(p, width = 402) {
  await p.setViewportSize({ width, height: 874 });
  await p.route('**/api/**', r => r.abort());
  await p.route('**/api/dictation', r =>
    r.fulfill({
      json:
        r.request().method() === 'GET'
          ? { available: true, provider: 'Voxtype' }
          : { text: 'dictated words' },
    })
  );
  await p.routeWebSocket('**/api/herdr/ws', ws => {
    ws.send(
      JSON.stringify({
        type: 'snapshot',
        snapshot: {
          workspaces: [{ workspace_id: 'test', label: 'Test' }],
          tabs: [
            { tab_id: 'a', label: 'First' },
            { tab_id: 'b', label: 'Second' },
          ],
          panes: ['a', 'b'].map(id => ({
            pane_id: id,
            tab_id: id,
            workspace_id: 'test',
            cwd: '/home/qa',
            agent: 'codex',
          })),
        },
      })
    );
    ws.onMessage(raw => {
      const m = JSON.parse(raw);
      if (m.type === 'input') throw Error('Dictation must not send input');
    });
  });
  await p.addInitScript(() => {
    window.stoppedTracks = 0;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => ({ getTracks: () => [{ stop: () => window.stoppedTracks++ }] }),
    });
    window.MediaRecorder = class {
      static isTypeSupported() {
        return true;
      }
      constructor() {
        this.state = 'inactive';
        this.mimeType = 'audio/mp4';
      }
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        queueMicrotask(() => {
          this.ondataavailable({ data: new Blob(['audio']) });
          this.onstop();
        });
      }
    };
  });
  await p.goto('/native/');
  await p.keyboard.press('Meta+Shift+A');
  const app = p.locator('#remote-herdr-app');
  await app.locator('.herdr-pane[data-pane="a"]').click();
  return app;
}
for (const width of [402, 1194]) {
  test(`dictation preserves draft and never sends at ${width}px`, async ({ page: p }) => {
    const app = await setup(p, width);
    await app.locator('textarea.native-input').fill('Existing draft');
    await app.getByRole('button', { name: 'Start dictation' }).click();
    await app.getByRole('button', { name: 'Stop dictation' }).click();
    await expect(app.locator('textarea.native-input')).toHaveValue('Existing draft dictated words');
    expect(await p.evaluate(() => window.stoppedTracks)).toBeGreaterThan(0);
    await p.reload();
    await expect(p.locator('#remote-herdr-app textarea.native-input')).toHaveValue(
      'Existing draft dictated words'
    );
  });
}
test('shortcut, cancellation, and delayed transcript keep the original thread', async ({
  page: p,
}) => {
  const app = await setup(p);
  await p.keyboard.press('Meta+Control+x');
  await expect(app.getByRole('button', { name: 'Stop dictation' })).toBeVisible();
  await app.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(app.getByRole('button', { name: 'Start dictation' })).toBeVisible();
  let release;
  const pending = new Promise(resolve => {
    release = resolve;
  });
  await p.route('**/api/dictation', async r => {
    if (r.request().method() === 'GET') return r.fulfill({ json: { available: true } });
    await pending;
    await r.fulfill({ json: { text: 'first thread only' } });
  });
  await app.getByRole('button', { name: 'Start dictation' }).click();
  await app.getByRole('button', { name: 'Stop dictation' }).click();
  await app
    .locator('.herdr-pane-tabs')
    .getByRole('button', { name: 'Second', exact: true })
    .click();
  release();
  await expect
    .poll(() => p.evaluate(() => localStorage.getItem('omarchy-herdr-drafts-v1')))
    .toContain('first thread only');
  await expect(app.locator('textarea.native-input')).not.toHaveValue('first thread only');
  await app.locator('.herdr-pane-tabs').getByRole('button', { name: 'First', exact: true }).click();
  await expect(app.locator('textarea.native-input')).toHaveValue('first thread only');
});
test('failed transcription can retry without recording again', async ({ page: p }) => {
  const app = await setup(p);
  let attempts = 0;
  await p.route('**/api/dictation', r => {
    if (r.request().method() === 'GET') return r.fulfill({ json: { available: true } });
    attempts++;
    return r.fulfill({
      status: attempts === 1 ? 502 : 200,
      json: attempts === 1 ? { error: 'Host busy' } : { text: 'recovered draft' },
    });
  });
  await app.getByRole('button', { name: 'Start dictation' }).click();
  await app.getByRole('button', { name: 'Stop dictation' }).click();
  await expect(app.locator('.dictation-notice')).toContainText('Host busy');
  await app.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(app.locator('textarea.native-input')).toHaveValue('recovered draft');
});
