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
  await p.keyboard.press('Escape');
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

async function voiceSetup(page, width = 402) {
  await page.addInitScript(() => {
    window.voicePlays = [];
    window.Audio = class {
      constructor() {
        this.paused = true;
        this.src = '';
      }
      play() {
        if (window.blockVoicePlayback && this.src.startsWith('blob:')) {
          this.paused = true;
          return Promise.reject(new Error('User gesture required'));
        }
        this.paused = false;
        if (window.deferVoicePlayback && this.src.startsWith('blob:')) {
          return new Promise(resolve => {
            window.releaseVoicePlayback = resolve;
          });
        }
        window.voicePlays.push(this.src);
        return Promise.resolve();
      }
      pause() {
        this.paused = true;
      }
      removeAttribute() {
        this.src = '';
      }
    };
  });
  const app = await setup(page, width);
  const state = {
    response: {
      can_send: true,
      session: 'session-a',
      working: false,
      answer: { id: 'old', text: 'Old answer' },
    },
    sent: [],
    generated: [],
  };
  await page.route('**/api/voice', r => r.fulfill({ json: { available: true } }));
  await page.route('**/api/herdr/panes/*/response', r => r.fulfill({ json: state.response }));
  await page.route('**/api/herdr/panes/*/voice-input', async r => {
    state.sent.push({ url: r.request().url(), data: r.request().postDataJSON() });
    await r.fulfill({ json: { type: 'ok' } });
  });
  await page.route('**/api/herdr/panes/*/speech', r => {
    state.generated.push(r.request().postDataJSON());
    return r.fulfill({ contentType: 'audio/wav', body: 'fixture audio' });
  });
  return { app, state };
}
test('voice sends dictation once and reads only a new completed answer', async ({ page }) => {
  const { app, state } = await voiceSetup(page);
  await app.getByRole('button', { name: 'Start dictation' }).click({ delay: 650 });
  await expect(app.locator('.herdr-voice-microphone')).toBeVisible();
  await app.getByRole('button', { name: 'Start dictation' }).click();
  await app.getByRole('button', { name: 'Stop dictation' }).click();
  await expect.poll(() => state.sent.length).toBe(1);
  expect(state.sent[0].data).toEqual({ text: 'dictated words', session: 'session-a' });
  expect(state.sent[0].url).toContain('/a/voice-input');
  await expect(app.locator('textarea.native-input')).toHaveValue('');
  state.response = { session: 'session-a', working: true, answer: { id: 'next', text: 'Answer' } };
  await page.waitForTimeout(3200);
  expect(state.generated).toEqual([]);
  state.response.working = false;
  await expect.poll(() => state.generated.length, { timeout: 6000 }).toBe(1);
  expect(state.generated[0]).toEqual({ response_id: 'next' });
  await expect(app.locator('.herdr-voice-status')).toContainText('Speaking');
  await page.waitForTimeout(3200);
  expect(state.generated).toHaveLength(1);
  await app.getByRole('button', { name: 'Stop speaking' }).click();
  await expect(app.getByRole('button', { name: 'Stop speaking' })).toBeHidden();
  await app.getByRole('button', { name: 'Read', exact: true }).click();
  await expect.poll(() => state.generated.length).toBe(2);
});
test('voice preserves an existing draft instead of automatically sending it', async ({ page }) => {
  const { app, state } = await voiceSetup(page);
  await app.getByRole('button', { name: 'Start dictation' }).click({ delay: 650 });
  await expect(app.locator('.herdr-voice-microphone')).toBeVisible();
  await app.locator('textarea.native-input').fill('Unsent thought');
  await app.getByRole('button', { name: 'Start dictation' }).click();
  await app.getByRole('button', { name: 'Stop dictation' }).click();
  await expect(app.locator('textarea.native-input')).toHaveValue('Unsent thought dictated words');
  await expect(app.locator('.herdr-voice-status')).toContainText('Saved as a draft');
  expect(state.sent).toEqual([]);
});
test('changing thread during voice transcription keeps a draft and disables voice', async ({
  page,
}) => {
  const { app, state } = await voiceSetup(page);
  await app.getByRole('button', { name: 'Start dictation' }).click({ delay: 650 });
  await expect(app.locator('.herdr-voice-microphone')).toBeVisible();
  let release;
  const pending = new Promise(resolve => {
    release = resolve;
  });
  await page.route('**/api/dictation', async r => {
    if (r.request().method() === 'GET') return r.fulfill({ json: { available: true } });
    await pending;
    return r.fulfill({ json: { text: 'Keep in original thread' } });
  });
  await app.getByRole('button', { name: 'Start dictation' }).click();
  await app.getByRole('button', { name: 'Stop dictation' }).click();
  await app
    .locator('.herdr-pane-tabs')
    .getByRole('button', { name: 'Second', exact: true })
    .click();
  release();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('omarchy-herdr-drafts-v1')))
    .toContain('Keep in original thread');
  await expect(app.locator('.herdr-voice-microphone')).toBeHidden();
  expect(state.sent).toEqual([]);
});
test('voice send failure retains the draft without retrying', async ({ page }) => {
  const { app } = await voiceSetup(page);
  let attempts = 0;
  await page.route('**/api/herdr/panes/*/voice-input', r => {
    attempts++;
    return r.abort();
  });
  await app.getByRole('button', { name: 'Start dictation' }).click({ delay: 650 });
  await expect(app.locator('.herdr-voice-microphone')).toBeVisible();
  await app.getByRole('button', { name: 'Start dictation' }).click();
  await app.getByRole('button', { name: 'Stop dictation' }).click();
  await expect(app.locator('.herdr-voice-status')).toContainText('Could not confirm sending');
  await expect(app.locator('textarea.native-input')).toHaveValue('dictated words');
  await page.waitForTimeout(3200);
  expect(attempts).toBe(1);
});
test('stop during speech generation prevents late playback', async ({ page }) => {
  const { app } = await voiceSetup(page);
  let release;
  const pending = new Promise(resolve => {
    release = resolve;
  });
  await page.route('**/api/herdr/panes/*/speech', async r => {
    await pending;
    return r.fulfill({ contentType: 'audio/wav', body: 'fixture audio' });
  });
  await app.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(app.locator('.herdr-voice-status')).toContainText('Generating speech');
  await app.getByRole('button', { name: 'Stop speaking' }).click();
  release();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.voicePlays.filter(s => s.startsWith('blob:')))).toEqual(
    []
  );
});

test('a microphone recording suppresses a late Read response', async ({ page }) => {
  const { app, state } = await voiceSetup(page);
  let release;
  const pending = new Promise(resolve => {
    release = resolve;
  });
  await page.route('**/api/herdr/panes/*/response', async r => {
    await pending;
    return r.fulfill({ json: state.response });
  });
  await app.getByRole('button', { name: 'Read', exact: true }).click();
  await app.getByRole('button', { name: 'Start dictation' }).click();
  await expect(app.getByRole('button', { name: 'Stop dictation' })).toBeVisible();
  release();
  await page.waitForTimeout(300);
  expect(state.generated).toEqual([]);
});
test('blocked autoplay exposes Play answer without regenerating audio', async ({ page }) => {
  const { app, state } = await voiceSetup(page);
  await page.evaluate(() => {
    window.blockVoicePlayback = true;
  });
  await app.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(app.getByRole('button', { name: 'Play answer', exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.blockVoicePlayback = false;
  });
  await app.getByRole('button', { name: 'Play answer', exact: true }).click();
  await expect(app.getByRole('button', { name: 'Stop speaking' })).toBeVisible();
  expect(state.generated).toHaveLength(1);
});

test('canceling a pending Play answer does not restore stale playback controls', async ({
  page,
}) => {
  const { app } = await voiceSetup(page);
  await page.evaluate(() => {
    window.blockVoicePlayback = true;
  });
  await app.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(app.getByRole('button', { name: 'Play answer', exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.blockVoicePlayback = false;
    window.deferVoicePlayback = true;
  });
  await app.getByRole('button', { name: 'Play answer', exact: true }).click();
  await app.getByRole('button', { name: 'Start dictation' }).click();
  await expect(app.getByRole('button', { name: 'Stop dictation' })).toBeVisible();
  await page.evaluate(() => window.releaseVoicePlayback());
  await expect(app.getByRole('button', { name: 'Stop speaking' })).toBeHidden();
});

test('canceling before the voice send check completes never sends', async ({ page }) => {
  const { app, state } = await voiceSetup(page);
  await app.getByRole('button', { name: 'Start dictation' }).click({ delay: 650 });
  await expect(app.locator('.herdr-voice-microphone')).toBeVisible();
  await app.getByRole('button', { name: 'Start dictation' }).click();
  let release;
  let checking = false;
  const pending = new Promise(resolve => {
    release = resolve;
  });
  await page.route('**/api/herdr/panes/*/response', async r => {
    checking = true;
    await pending;
    return r.fulfill({ json: state.response });
  });
  await app.getByRole('button', { name: 'Stop dictation' }).click();
  await expect.poll(() => checking).toBe(true);
  await page.keyboard.press('Escape');
  release();
  await page.waitForTimeout(300);
  expect(state.sent).toEqual([]);
  await expect(app.locator('textarea.native-input')).toHaveValue('dictated words');
});

for (const width of [402, 1194]) {
  test(`voice floating microphone stays in place through capture at ${width}px`, async ({
    page,
  }) => {
    const { app, state } = await voiceSetup(page, width);
    const floating = app.locator('.herdr-voice-microphone');
    const small = app.locator('.dictation-button');
    await expect(floating).toBeHidden();
    await expect(small).toBeVisible();
    await app.getByRole('button', { name: 'Start dictation' }).click({ delay: 650 });
    await expect(floating).toBeVisible();
    await expect(small).toBeVisible();
    await expect(small).toHaveAccessibleName('Turn off Voice mode');
    await expect(floating).toHaveText('Talk');
    const before = await floating.boundingBox();
    expect(before.width).toBe(80);
    expect(before.height).toBe(80);
    const output = await app.locator('.herdr-output').boundingBox();
    expect(before.x).toBeGreaterThan(output.x + output.width / 2);
    expect(before.x + before.width).toBeLessThan(output.x + output.width);
    await floating.click();
    await expect(floating).toHaveText('Send');
    await expect(floating).toHaveAttribute('aria-pressed', 'true');
    expect(await floating.boundingBox()).toEqual(before);
    await page.screenshot({ path: `artifacts/voice-floating-recording-${width}.png` });
    let release;
    const pending = new Promise(resolve => {
      release = resolve;
    });
    await page.route('**/api/dictation', async r => {
      await pending;
      return r.fulfill({ json: { text: 'dictated words' } });
    });
    await floating.click();
    await expect(floating).toBeDisabled();
    await expect(floating).toHaveText('Wait…');
    expect(await floating.boundingBox()).toEqual(before);
    release();
    await expect.poll(() => state.sent.length).toBe(1);
    await expect(floating).toBeEnabled();
    await expect(floating).toHaveText('Talk');
    await page.screenshot({ path: `artifacts/voice-floating-ready-${width}.png` });
    // A tap to speak must stop current audio before the microphone opens.
    await app.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(app.getByRole('button', { name: 'Stop speaking' })).toBeVisible();
    await page.unroute('**/api/dictation');
    await page.route('**/api/dictation', r => r.fulfill({ json: { available: true } }));
    await floating.click();
    await expect(floating).toHaveText('Send');
    await expect(app.getByRole('button', { name: 'Stop speaking' })).toBeHidden();
    await app.getByRole('button', { name: 'Turn off Voice mode' }).click();
    await expect(floating).toBeHidden();
    await expect(small).toBeVisible();
  });
}

for (const width of [402, 1194]) {
  test(`voice controls preserve output space at ${width}px`, async ({ page }) => {
    const { app } = await voiceSetup(page, width);
    const output = app.locator('.herdr-output');
    const initial = await output.boundingBox();
    const replay = app.getByRole('button', { name: 'Read', exact: true });
    const fit = app.locator('.herdr-output-tools').getByRole('button', { name: /Fit|Original/ });
    expect((await replay.boundingBox()).y).toBe((await fit.boundingBox()).y);
    await expect(app.getByRole('button', { name: 'Microphone options' })).toHaveCount(0);
    await app.getByRole('button', { name: 'Start dictation' }).click();
    await expect(app.getByRole('button', { name: 'Stop dictation' })).toBeVisible();
    await expect(app.locator('.dictation-notice')).toBeHidden();
    await expect(app.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    expect(await output.boundingBox()).toEqual(initial);
    await page.screenshot({ path: `artifacts/voice-compact-recording-${width}.png` });
    await app.getByRole('button', { name: 'Stop dictation' }).click();
    await expect(app.locator('textarea.native-input')).toHaveValue('dictated words');
    expect(await output.boundingBox()).toEqual(initial);
    await replay.click();
    await expect(app.getByRole('button', { name: 'Stop speaking' })).toBeVisible();
    expect(await output.boundingBox()).toEqual(initial);
  });
}

test('holding toggles Voice without recording; dragging cancels and keyboard is equivalent', async ({
  page,
}) => {
  const { app, state } = await voiceSetup(page);
  const small = app.locator('.dictation-button');
  const floating = app.locator('.herdr-voice-microphone');
  await small.click({ delay: 650 });
  await expect(floating).toBeVisible();
  await expect(floating).toHaveText('Talk');
  await floating.click({ delay: 650 });
  await expect(floating).toBeHidden();
  await expect(small).toHaveAttribute('aria-pressed', 'false');
  const box = await small.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 20, box.y + box.height / 2);
  await page.waitForTimeout(650);
  await page.mouse.up();
  await expect(floating).toBeHidden();
  await expect(small).toHaveAttribute('aria-pressed', 'false');
  await small.focus();
  await page.keyboard.press('Shift+Enter');
  await expect(floating).toBeVisible();
  await floating.focus();
  await page.keyboard.press('Shift+Enter');
  await expect(floating).toBeHidden();
  expect(state.sent).toEqual([]);
});

for (const width of [402, 1194]) {
  test(`voice off button cancels pending transcription and restores microphone at ${width}px`, async ({
    page,
  }) => {
    const { app, state } = await voiceSetup(page, width);
    const small = app.locator('.dictation-button');
    const before = await small.boundingBox();
    await small.click({ delay: 650 });
    await expect(small).toHaveAccessibleName('Turn off Voice mode');
    await expect(small).toHaveAttribute('data-mode', 'voice');
    expect(await small.boundingBox()).toEqual(before);
    await app.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(app.getByRole('button', { name: 'Stop speaking' })).toBeVisible();
    await small.click();
    await expect(app.getByRole('button', { name: 'Stop speaking' })).toBeHidden();
    await expect(small).toHaveAccessibleName('Start dictation');
    await small.click({ delay: 650 });
    const floating = app.locator('.herdr-voice-microphone');
    await floating.click();
    await expect(floating).toHaveText('Send');
    let release;
    let transcribing = false;
    const pending = new Promise(resolve => {
      release = resolve;
    });
    await page.route('**/api/dictation', async r => {
      transcribing = true;
      await pending;
      await r.fulfill({ json: { text: 'Canceled voice request' } });
    });
    await floating.click();
    await expect.poll(() => transcribing).toBe(true);
    await expect(small).toBeEnabled();
    await small.click();
    await expect(floating).toBeHidden();
    await expect(small).toHaveAccessibleName('Start dictation');
    release();
    await page.waitForTimeout(300);
    expect(state.sent).toEqual([]);
    await expect(app.locator('textarea.native-input')).toHaveValue('');
  });
}
