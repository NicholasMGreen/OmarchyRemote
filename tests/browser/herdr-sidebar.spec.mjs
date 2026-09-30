import { test, expect } from './fixtures.mjs';
async function open(p) {
  await p.setViewportSize({ width: 1194, height: 834 });
  await p.route('**/api/**', r => r.abort());
  await p.routeWebSocket('**/api/herdr/ws', ws =>
    ws.send(
      JSON.stringify({
        type: 'snapshot',
        snapshot: {
          workspaces: [{ workspace_id: 'qa', label: 'Project' }],
          tabs: [{ tab_id: 'qa:t1', label: 'Agent' }],
          panes: [
            {
              pane_id: 'qa:p1',
              tab_id: 'qa:t1',
              workspace_id: 'qa',
              cwd: '/home/qa',
              agent: 'codex',
            },
          ],
        },
      })
    )
  );
  await p.goto('/native/');
  await p.keyboard.press('Meta+Shift+A');
  const app = p.locator('#remote-herdr-app');
  await app.locator('.herdr-pane').click();
  return app;
}
test('resize, hide and restore the wide sidebar without changing phone navigation', async ({
  page: p,
}) => {
  const app = await open(p);
  const divider = app.getByRole('separator', { name: 'Resize Herdr sidebar' });
  await expect(divider).toBeVisible();
  const bounds = await divider.boundingBox();
  await p.mouse.move(bounds.x + bounds.width / 2, bounds.y + 80);
  await p.mouse.down();
  await p.mouse.move(bounds.x + bounds.width / 2 - 100, bounds.y + 80, { steps: 10 });
  await p.mouse.up();
  await expect(divider).toHaveAttribute('aria-valuenow', '200');
  await expect(app.locator('.herdr-search-field')).toBeVisible();
  await divider.focus();
  await p.keyboard.press('ArrowLeft');
  await expect(divider).toHaveAttribute('aria-valuenow', '184');
  await p.keyboard.press('Home');
  await expect(divider).toHaveAttribute('aria-valuenow', '180');
  await app.getByRole('button', { name: 'Hide Herdr sidebar' }).click();
  await expect(app.locator('.herdr-search-field')).toBeHidden();
  await expect(divider).toBeHidden();
  await expect(app.getByRole('button', { name: 'Show Herdr sidebar' })).toBeVisible();
  await p.reload();
  await expect(app.getByRole('button', { name: 'Show Herdr sidebar' })).toBeVisible();
  await app.getByRole('button', { name: 'Show Herdr sidebar' }).click();
  await expect(divider).toHaveAttribute('aria-valuenow', '180');
  await expect(app.locator('.herdr-list')).toBeVisible();
  expect(await app.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await p.setViewportSize({ width: 402, height: 874 });
  await expect(divider).toBeHidden();
  await expect(app.getByRole('button', { name: 'Hide Herdr sidebar' })).toBeHidden();
  await app.getByRole('button', { name: 'All panes', exact: true }).click();
  await expect(app.locator('.herdr-list')).toBeVisible();
});
