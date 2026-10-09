import { test, expect } from './fixtures.mjs';

// Like a terminal window, the open pane is sized to the view showing it.
async function setup(p, width, height) {
  await p.setViewportSize({ width, height });
  await p.route('**/api/**', r => r.abort());
  const snapshot = {
    workspaces: [{ workspace_id: 'qa', label: 'Size QA' }],
    tabs: [{ tab_id: 'qa:t1', label: '1' }],
    panes: ['qa:p1', 'qa:p2'].map(pane_id => ({
      pane_id,
      tab_id: 'qa:t1',
      workspace_id: 'qa',
    })),
  };
  const sizes = [];
  await p.routeWebSocket('**/api/herdr/ws', ws => {
    ws.send(JSON.stringify({ type: 'snapshot', snapshot }));
    ws.onMessage(raw => {
      const m = JSON.parse(raw);
      if (m.type === 'size') sizes.push(m);
      if (m.type === 'select' && m.pane_id)
        ws.send(
          JSON.stringify({
            type: 'pane',
            pane_id: m.pane_id,
            read: { pane_id: m.pane_id, text: 'justin@host ~ ❯ ' },
          })
        );
    });
  });
  await p.goto('/native/');
  await p.keyboard.press('Meta+Shift+A');
  const app = p.locator('#remote-herdr-app');
  return { app, sizes };
}

test('the open pane takes the width and height of the phone view', async ({ page }) => {
  const { app, sizes } = await setup(page, 402, 874);
  await app.locator('.herdr-pane[data-pane="qa:p1"]').click();
  await expect.poll(() => sizes.length).toBe(1);
  const [size] = sizes;
  expect(size).toMatchObject({ type: 'size', pane_id: 'qa:p1' });
  // A 402 px phone fits about 50 columns of 12 px text, not Herdr's 44 or 80.
  expect(size.cols).toBeGreaterThan(44);
  expect(size.cols).toBeLessThan(60);
  expect(size.rows).toBeGreaterThan(20);
  // The same size again is not sent; opening another pane sizes that one.
  await page.waitForTimeout(500);
  expect(sizes).toHaveLength(1);
  await app.getByRole('button', { name: 'All panes' }).click();
  await app.locator('.herdr-pane[data-pane="qa:p2"]').click();
  await expect.poll(() => sizes.map(s => s.pane_id)).toEqual(['qa:p1', 'qa:p2']);
});

test('a desk window that grows resizes the open pane wider', async ({ page }) => {
  const { app, sizes } = await setup(page, 1194, 834);
  await app.locator('.herdr-pane[data-pane="qa:p1"]').click();
  await expect.poll(() => sizes.length).toBe(1);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect.poll(() => sizes.length).toBe(2);
  expect(sizes[1].pane_id).toBe('qa:p1');
  expect(sizes[1].cols).toBeGreaterThan(sizes[0].cols);
  expect(sizes[1].rows).toBeGreaterThan(sizes[0].rows);
});

test('an on-screen keyboard covering the view leaves the pane height alone', async ({ page }) => {
  const { app, sizes } = await setup(page, 402, 874);
  await app.locator('.herdr-pane[data-pane="qa:p1"]').click();
  await expect.poll(() => sizes.length).toBe(1);
  // The system keyboard shrinks the visual viewport, as on an iPhone.
  const keyboard = height =>
    page.evaluate(height => {
      Object.defineProperty(window.visualViewport, 'height', {
        configurable: true,
        get: () => window.innerHeight - height,
      });
      window.dispatchEvent(new Event('resize'));
    }, height);
  await keyboard(336);
  await expect(page.locator('html.system-keyboard-open')).toHaveCount(1);
  await page.waitForTimeout(800);
  expect(sizes).toHaveLength(1);
  await keyboard(0);
  await page.waitForTimeout(800);
  expect(sizes).toHaveLength(1);
});
