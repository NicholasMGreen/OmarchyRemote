import { test, expect } from './fixtures.mjs';

// An idle agent with background commands still running is waiting, not done.
test('an agent waiting on background work shows it in the list, header and Home widget', async ({
  page: p,
}) => {
  await p.setViewportSize({ width: 402, height: 874 });
  await p.route('**/api/**', r => r.abort());
  const snapshot = {
    workspaces: [
      { workspace_id: 'a', label: 'Finished project' },
      { workspace_id: 'b', label: 'Build project' },
    ],
    tabs: [
      { tab_id: 'a:t1', label: 'Finished' },
      { tab_id: 'b:t1', label: 'Tests' },
    ],
    panes: [
      {
        pane_id: 'a:p1',
        tab_id: 'a:t1',
        workspace_id: 'a',
        agent: 'claude',
        agent_status: 'done',
        state_change_seq: 9,
      },
      {
        pane_id: 'b:p1',
        tab_id: 'b:t1',
        workspace_id: 'b',
        agent: 'claude',
        agent_status: 'idle',
        state_change_seq: 1,
        background: [
          { description: 'Run the full Playwright suite', started: '2026-10-05T10:00:00Z' },
          { description: 'Build the release binary', started: '2026-10-05T10:01:00Z' },
        ],
      },
    ],
  };
  await p.route('**/api/herdr/snapshot', r => r.fulfill({ json: snapshot }));
  await p.routeWebSocket('**/api/herdr/ws', ws => {
    ws.send(JSON.stringify({ type: 'snapshot', snapshot }));
    ws.onMessage(() => {});
  });
  await p.goto('/native/');
  // Home: the waiting agent counts as working, labelled Waiting.
  const widget = p.locator('#widget-herdr');
  await expect(widget.locator('.herdr-widget-thread')).toHaveCount(1);
  await expect(widget.locator('.herdr-widget-state')).toHaveText('Waiting');
  await p.getByText('herdr', { exact: true }).first().click();
  const rows = p.locator('#remote-herdr-app .herdr-pane');
  await expect(rows).toHaveCount(2);
  // It sorts with working agents, ahead of the finished one.
  await expect(rows.first()).toHaveAttribute('data-pane', 'b:p1');
  const waiting = rows.first();
  await expect(waiting.locator('.herdr-state')).toHaveText('waiting');
  await expect(waiting.locator('.state-dot')).toHaveAttribute('data-group', 'running');
  await expect(waiting.locator('.herdr-background')).toHaveText(
    '⏳ Run the full Playwright suite +1'
  );
  await expect(waiting.locator('.herdr-background')).toHaveAttribute(
    'title',
    'Run the full Playwright suite\nBuild the release binary'
  );
  await expect(rows.last().locator('.herdr-state')).toHaveText('done');
  await expect(rows.last().locator('.herdr-background')).toHaveCount(0);
  await p.waitForTimeout(500);
  await p.screenshot({ path: 'artifacts/browser/herdr-background.png' });
  await waiting.click();
  await expect(p.locator('#remote-herdr-app .herdr-metadata')).toContainText(
    'claude · waiting on 2 background tasks'
  );
});
