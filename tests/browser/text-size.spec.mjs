import { test, expect } from './fixtures.mjs';
import { captureTerminals } from './terminal-helper.mjs';

test('text size scales shell text without moving layout and survives reload', async ({ page }) => {
  await page.route('**/api/**', route => route.abort());
  await page.goto('/native/');
  const name = page.locator('.home-tile-name').first();
  await expect(name).toBeVisible();
  await expect(name).toHaveCSS('font-size', '10px');
  await page.keyboard.press('Meta+Comma');
  const control = page.getByRole('combobox', { name: 'Text size' });
  await control.selectOption('80');
  await expect(name).toHaveCSS('font-size', '8px');
  // Layout boxes keep their size while text scales.
  await expect(page.locator('.home-tile').first()).toHaveCSS('height', '62px');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('omarchy-text-scale')))
    .toBe('80');
  await page.reload();
  await page.keyboard.press('Meta+Comma');
  await expect(page.getByRole('combobox', { name: 'Text size' })).toHaveValue('80');
  await expect(page.locator('.home-tile-name').first()).toHaveCSS('font-size', '8px');
});

test('text size returns to the default at 100%', async ({ page }) => {
  await page.route('**/api/**', route => route.abort());
  await page.goto('/native/');
  const name = page.locator('.home-tile-name').first();
  await expect(name).toBeVisible();
  await page.keyboard.press('Meta+Comma');
  const control = page.getByRole('combobox', { name: 'Text size' });
  await control.selectOption('80');
  await expect(name).toHaveCSS('font-size', '8px');
  await control.selectOption('100');
  await expect(name).toHaveCSS('font-size', '10px');
  await expect(page.locator('.home-tile').first()).toHaveCSS('height', '62px');
});

test('text size rescales Terminal live and survives reload', async ({ page: p }) => {
  await captureTerminals(p);
  await p.route('**/api/terminal/session', r => r.fulfill({ json: { id: 'qa-scale' } }));
  await p.routeWebSocket('**/api/terminal/*/ws', ws => {
    ws.send(
      JSON.stringify({ type: 'screen', cols: 80, rows: 24, data: Array.from(Buffer.from('$ ')) })
    );
    ws.onMessage(() => {});
  });
  await p.goto('/native/');
  await expect(p.getByText('herdr', { exact: true }).first()).toBeVisible();
  await p.evaluate(() => {
    window.__HYPRLAND_HARDWARE_KEYBOARD__ = true;
    dispatchEvent(new Event('hyprland-hardware-keyboard'));
  });
  await p.keyboard.press('Meta+Enter');
  const root = p.locator('#remote-terminal-app');
  await expect(root.locator('.remote-status')).toBeHidden();
  await expect.poll(() => p.evaluate(() => qaTerms.length)).toBeGreaterThanOrEqual(1);
  await expect.poll(() => p.evaluate(() => qaTerms[0]?.options.fontSize)).toBeGreaterThan(0);
  await p.evaluate(() => HyprlandTextScale.set('80'));
  expect(await p.evaluate(() => qaTerms[0].options.fontSize)).toBeCloseTo(9.6);
  await p.evaluate(() => HyprlandTextScale.set('100'));
  expect(await p.evaluate(() => qaTerms[0].options.fontSize)).toBeCloseTo(12);
  await p.reload();
  await expect.poll(() => p.evaluate(() => qaTerms[0]?.options.fontSize)).toBeCloseTo(12);
});

test('host TUI Fit width ignores Text size; the Larger toggle follows it', async ({ page: p }) => {
  await captureTerminals(p);
  await p.route('**/api/terminal/session', r => r.fulfill({ json: { id: 'qa-tui' } }));
  await p.routeWebSocket('**/api/terminal/*/ws', ws => {
    ws.send(
      JSON.stringify({ type: 'screen', cols: 80, rows: 24, data: Array.from(Buffer.from('$ ')) })
    );
    ws.onMessage(() => {});
  });
  await p.goto('/native/');
  await expect(p.getByText('herdr', { exact: true }).first()).toBeVisible();
  await p.getByText('btop', { exact: true }).first().click();
  const app = p.locator('#remote-btop-app');
  await expect(app.locator('.remote-status')).toBeHidden();
  await expect.poll(() => p.evaluate(() => qaTerms.length)).toBeGreaterThanOrEqual(1);
  // With Fit width on, the fit guarantee owns the font size and ignores Text size.
  await expect.poll(() => p.evaluate(() => qaTerms[0].options.fontSize)).toBeLessThanOrEqual(12);
  const fitted = await p.evaluate(() => qaTerms[0].options.fontSize);
  await p.evaluate(() => HyprlandTextScale.set('80'));
  expect(await p.evaluate(() => qaTerms[0].options.fontSize)).toBeCloseTo(fitted);
  // The Larger toggle uses the fixed font, which follows the Text size setting.
  await app.getByRole('button', { name: 'Larger', exact: true }).click();
  expect(await p.evaluate(() => qaTerms[0].options.fontSize)).toBeCloseTo(9.6);
  await expect
    .poll(() =>
      p.evaluate(() =>
        parseFloat(
          getComputedStyle(
            document.querySelector('#remote-btop-app .remote-terminal')
          ).getPropertyValue('--host-tui-font') || '0'
        )
      )
    )
    .toBeCloseTo(9.6);
  await p.evaluate(() => HyprlandTextScale.set('100'));
  expect(await p.evaluate(() => qaTerms[0].options.fontSize)).toBeCloseTo(12);
});
