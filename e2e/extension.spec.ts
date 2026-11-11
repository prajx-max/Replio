import { test, expect, chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

test('unpacked MV3 shell: mock event, settings persistence, page sync and responsive UI', async () => {
  const extensionPath = resolve('apps/extension/dist');
  const localBrowser = resolve('.browser-cache/chrome-win64/chrome.exe');
  const executablePath =
    process.env.CHROMIUM_EXECUTABLE_PATH ??
    (process.platform === 'win32' && existsSync(localBrowser)
      ? localBrowser
      : undefined);
  const context = await chromium.launchPersistentContext('', {
    ...(executablePath ? { executablePath } : { channel: 'chromium' }),
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(15000);
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).hostname;
    const errors: string[] = [];
    const popup = await context.newPage();
    popup.on('pageerror', (error) => errors.push(error.message));
    await popup.setViewportSize({ width: 360, height: 680 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(
      popup.getByRole('checkbox', { name: 'Assistant enabled' }),
    ).toBeChecked();
    await expect(popup.getByText('Adapter pending')).toBeVisible();
    await expect(
      popup.getByRole('button', { name: /Open reply workspace/ }),
    ).toBeEnabled();
    await mkdir('artifacts/milestone-1', { recursive: true });
    await popup.screenshot({
      path: 'artifacts/milestone-1/popup.png',
      fullPage: true,
    });

    const panel = await context.newPage();
    panel.on('pageerror', (error) => errors.push(error.message));
    await panel.setViewportSize({ width: 420, height: 980 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.getByText('Optional sample preview', { exact: true }).click();
    await panel.getByRole('button', { name: /Try a sample enquiry/ }).click();
    await expect(
      panel.getByRole('textbox', { name: 'Suggested reply' }),
    ).toHaveValue(/₹650 for 500 grams/);
    await expect(
      panel.getByRole('button', { name: 'Send reply' }),
    ).toBeDisabled();
    await expect(
      panel.getByRole('button', { name: 'Insert draft' }),
    ).toBeDisabled();
    await expect(
      panel.getByText(
        'Fictional conversation. This sample does not read or send WhatsApp messages.',
      ),
    ).toBeVisible();
    await panel.screenshot({
      path: 'artifacts/milestone-1/sidepanel.png',
      fullPage: true,
    });
    await test.step('Reload the sample workspace', () => panel.reload());
    await panel.getByText('Optional sample preview', { exact: true }).click();
    await expect(
      panel.getByRole('textbox', { name: 'Suggested reply' }),
    ).toHaveValue(/₹650 for 500 grams/);

    const options = await test.step('Open an options page', () =>
      context.newPage());
    options.on('pageerror', (error) => errors.push(error.message));
    await options.setViewportSize({ width: 1280, height: 1000 });
    await test.step('Load the packaged options page', () =>
      options.goto(`chrome-extension://${extensionId}/options.html`));
    await options
      .getByLabel('Business name', { exact: true })
      .fill('My Demo Bakery');
    await options
      .getByRole('combobox', { name: 'Tone', exact: true })
      .selectOption('professional');
    await options.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      options.getByText('Settings saved', { exact: true }),
    ).toBeVisible();
    await options.reload();
    await expect(
      options.getByLabel('Business name', { exact: true }),
    ).toHaveValue('My Demo Bakery');
    await expect(
      options.getByRole('combobox', { name: 'Tone', exact: true }),
    ).toHaveValue('professional');
    await expect(
      popup.getByRole('combobox', { name: 'Active business' }),
    ).toHaveValue('sweet-crumbs-demo');
    await expect(
      popup.getByRole('option', { name: 'My Demo Bakery' }),
    ).toBeAttached();
    await expect(
      panel.getByText('My Demo Bakery', { exact: true }),
    ).toBeVisible();
    await options.screenshot({
      path: 'artifacts/milestone-1/options.png',
      fullPage: true,
    });

    // A dirty form keeps edits when another extension page changes settings.
    await options
      .getByLabel('Business name', { exact: true })
      .fill('Unsaved local edit');
    await popup.getByRole('checkbox', { name: 'Assistant enabled' }).uncheck();
    await expect(
      options.getByRole('button', { name: 'Save changes' }),
    ).toBeDisabled();
    await expect(options.getByText(/Settings changed elsewhere/)).toBeVisible();
    await expect(
      options.getByLabel('Business name', { exact: true }),
    ).toHaveValue('Unsaved local edit');
    await popup.reload();
    await expect(
      popup.getByRole('checkbox', { name: 'Assistant enabled' }),
    ).not.toBeChecked();
    await expect(
      panel.getByRole('button', { name: /Run sample again/ }),
    ).toBeDisabled();

    await options.setViewportSize({ width: 360, height: 900 });
    await expect
      .poll(() =>
        options.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await options.screenshot({
      path: 'artifacts/milestone-1/options-mobile.png',
      fullPage: true,
    });
    await panel.setViewportSize({ width: 320, height: 900 });
    await expect
      .poll(() =>
        panel.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
