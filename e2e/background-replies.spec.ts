import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createBackend } from '../apps/api/dist/index.js';
import { ShellResponseSchema } from '../apps/extension/src/messaging/contracts.js';

test('background replies: inactive tab, unread recovery after backend restart and opt-in revocation', async () => {
  const connectionDirectory = await mkdtemp(
    join(tmpdir(), 'replio-background-'),
  );
  const connectionFile = join(connectionDirectory, '.env.connections');
  const createFixtureBackend = () =>
    createBackend({
      port: 4175,
      connectionFile,
      provider: {
        async generate() {
          return {
            reply: 'Hello!',
            needsHuman: false,
            evidenceIds: ['business-information'],
          };
        },
      },
    });
  let backend = createFixtureBackend();
  const connection = backend.store.configure({
    profileId: 'sweet-crumbs-demo',
    provider: 'groq',
    model: 'fixture',
    apiKey: 'fixture-background-key',
    remember: true,
  });
  await backend.listen();
  const fixture = createServer((request, response) => {
    const file =
      request.url === '/fixture.js'
        ? 'fixture.js'
        : request.url === '/fixture.css'
          ? 'fixture.css'
          : 'index.html';
    response.setHeader(
      'Content-Type',
      file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/html',
    );
    void readFile(resolve('packages/test-fixtures/whatsapp-page', file)).then(
      (buffer) => response.end(buffer),
      () => {
        response.writeHead(500);
        response.end();
      },
    );
  });
  await new Promise<void>((accept, reject) => {
    fixture.once('error', reject);
    fixture.listen(4174, '127.0.0.1', accept);
  });
  const path = resolve('.browser-cache/chrome-win64/chrome.exe');
  const executablePath =
    process.env.CHROMIUM_EXECUTABLE_PATH ??
    (process.platform === 'win32' && existsSync(path) ? path : undefined);
  const extension = resolve('apps/extension/dist-fixture');
  const context = await chromium.launchPersistentContext('', {
    ...(executablePath ? { executablePath } : { channel: 'chromium' }),
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  context.setDefaultTimeout(10000);
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).hostname;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await options
      .getByRole('textbox', { name: /^Backend pairing code/ })
      .fill(connection.pairingCode);
    await options
      .getByRole('button', { name: 'Connect AI backend', exact: true })
      .click();
    await expect(options.getByText('Connected', { exact: true })).toBeVisible();
    await options
      .getByRole('textbox', { name: /^Business information/ })
      .fill('Our team can help with general questions.');
    await options.getByRole('radio', { name: /^Auto-reply/ }).check();
    await options
      .getByRole('checkbox', {
        name: /^Allow automatic sending without review/,
      })
      .check();
    await options
      .getByLabel('Minimum time between replies (seconds)')
      .fill('0');
    await expect(
      options.getByRole('checkbox', {
        name: /^Reply while WhatsApp is in the background/,
      }),
    ).not.toBeChecked();
    await options.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      options.getByText('Settings saved', { exact: true }),
    ).toBeVisible();
    const chat = await context.newPage();
    await chat.goto(
      'http://127.0.0.1:4174/?themeRows&rewriteComposer&inbox&splitUnreadRender',
    );
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);
    await expect(panel.getByText('Chat ready', { exact: true })).toBeVisible();
    const other = await context.newPage();
    await other.goto('about:blank');
    // Headless Chromium exposes all pages as visible. Simulate hidden in the
    // content script world; the worker uses actual Chrome active-tab state.
    const cdp = await context.newCDPSession(chat);
    let worldId: number | undefined;
    cdp.on(
      'Runtime.executionContextCreated',
      ({
        context: world,
      }: {
        context: { id: number; origin: string; auxData?: { type?: string } };
      }) => {
        if (
          world.origin === `chrome-extension://${id}` &&
          world.auxData?.type === 'isolated'
        )
          worldId = world.id;
      },
    );
    await cdp.send('Runtime.enable');
    await expect.poll(() => worldId).toBeDefined();
    async function visibility(state: 'visible' | 'hidden') {
      if (worldId === undefined)
        throw new Error('Missing synthetic adapter world');
      const result = await cdp.send('Runtime.evaluate', {
        contextId: worldId,
        expression: `Object.defineProperty(document, 'visibilityState', { configurable: true, value: '${state}' }); document.dispatchEvent(new Event('visibilitychange'));`,
        returnByValue: true,
      });
      expect(result.exceptionDetails).toBeUndefined();
    }
    async function receive(text: string) {
      await chat.evaluate((value) => {
        const input = document.querySelector<HTMLInputElement>('#question');
        if (!input) throw new Error('Missing fixture input');
        input.value = value;
        document.querySelector<HTMLButtonElement>('#incoming')?.click();
      }, text);
    }
    await other.bringToFront();
    await visibility('hidden');
    await receive('Hello before background consent');
    await expect(
      panel.getByRole('textbox', { name: /^Live suggested reply/ }),
    ).toHaveValue('Hello!');
    await expect(chat.locator('#sent')).toHaveText('0');

    await options.bringToFront();
    await options
      .getByRole('checkbox', {
        name: /^Reply while WhatsApp is in the background/,
      })
      .check();
    await options
      .getByRole('checkbox', { name: /^Open new unread chats automatically/ })
      .check();
    await options.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      options.getByText('Settings saved', { exact: true }),
    ).toBeVisible();
    await expect(panel.getByText('Chat ready', { exact: true })).toBeVisible();
    await other.bringToFront();
    await expect
      .poll(() =>
        worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({
            url: 'http://127.0.0.1:4174/*',
          });
          return { active: tab?.active, autoDiscardable: tab?.autoDiscardable };
        }),
      )
      .toEqual({ active: false, autoDiscardable: false });
    async function backgroundState() {
      const response: unknown = await options.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'GET_STATE', version: 1 }),
      );
      const parsed = ShellResponseSchema.parse(response);
      if (!parsed.ok) throw new Error(parsed.error);
      const state = parsed.state;
      return {
        saved: state.settings.profiles.find(
          (profile) => profile.id === state.settings.activeProfileId,
        )?.backgroundReplies,
        adapter: state.live?.status.structure?.backgroundReplies,
        ready: state.live?.status.ready,
        runtime: state.backgroundRuntime?.state,
      };
    }
    // An old panel snapshot can still say Chat ready while the saved config is
    // hydrating. Verify the running adapter's new policy before the arrival.
    await expect
      .poll(backgroundState)
      .toEqual({ saved: true, adapter: true, ready: true, runtime: 'READY' });
    await receive('Hi from the background');
    try {
      await expect(chat.locator('#sent')).toHaveText('1');
    } catch (error) {
      const response: unknown = await options.evaluate(() =>
        chrome.runtime.sendMessage({
          type: 'GET_STATE',
          version: 1,
        }),
      );
      const parsed = ShellResponseSchema.parse(response);
      const state = parsed.ok ? parsed.state : null;
      const diagnostic = {
        runtime: state?.backgroundRuntime,
        observation: state?.live?.status.observation,
        structure: state?.live?.status.structure,
        suggestion: state?.live?.suggestion?.state,
        error: state?.live?.suggestion?.error,
        delivery: state?.live?.suggestion?.delivery,
      };
      await test.info().attach('background-failure', {
        body: JSON.stringify(diagnostic),
        contentType: 'application/json',
      });
      throw error;
    }
    await receive('Hi again from the background');
    await expect(chat.locator('#sent')).toHaveText('2');
    await backend.close();
    backend = createFixtureBackend();
    await chat.evaluate(() =>
      [...document.querySelectorAll('button')]
        .find(
          (button) =>
            button.textContent === 'Receive unread messages in two chats',
        )
        ?.click(),
    );
    await expect(
      panel.getByText(/Waiting for the local backend/),
    ).toBeVisible();
    await expect(chat.locator('#sent')).toHaveText('2');
    await expect(chat.locator('#inbox-replies li')).toHaveCount(0);
    await chat
      .getByRole('button', { name: 'Remount the chat list', exact: true })
      .evaluate((button: HTMLButtonElement) => button.click());
    await backend.listen();
    await expect(chat.locator('#inbox-replies li')).toHaveText(
      ['Lina — Hello!', 'Omar — Hello!'],
      { timeout: 20000 },
    );
    await expect(chat.locator('#sent')).toHaveText('4');
    await mkdir('artifacts/whatsapp-ai', { recursive: true });
    await options.locator('.mode-fieldset').screenshot({
      path: 'artifacts/whatsapp-ai/background-reply-settings.png',
    });
    await options.setViewportSize({ width: 360, height: 900 });
    expect(
      await options.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(360);
    await options.locator('.mode-fieldset').screenshot({
      path: 'artifacts/whatsapp-ai/background-reply-mobile.png',
    });
    // Reading another tab must not be interrupted by automation.
    expect(
      await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        const [wa] = await chrome.tabs.query({
          url: 'http://127.0.0.1:4174/*',
        });
        return tab?.id !== wa?.id;
      }),
    ).toBe(true);
    // Human drafts remain protected in the same background mode.
    await chat
      .locator('#main footer [contenteditable="true"]')
      .evaluate((editor) => {
        editor.textContent = 'Operator draft';
        editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      });
    await receive('Hello while a human draft exists');
    await expect(
      panel.getByText(/The composer already contains text or was edited/),
    ).toBeVisible();
    await expect(chat.locator('#sent')).toHaveText('4');
    await expect(
      chat.locator('#main footer [contenteditable="true"]'),
    ).toHaveText('Operator draft');
    await options.bringToFront();
    await options
      .getByRole('checkbox', {
        name: /^Reply while WhatsApp is in the background/,
      })
      .uncheck();
    await options.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      options.getByText('Settings saved', { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        worker.evaluate(
          async () =>
            (await chrome.tabs.query({ url: 'http://127.0.0.1:4174/*' }))[0]
              ?.autoDiscardable,
        ),
      )
      .toBe(true);
    await expect(panel.getByText('Chat ready', { exact: true })).toBeVisible();
    await other.bringToFront();
    await chat
      .locator('#main footer [contenteditable="true"]')
      .evaluate((editor) => {
        editor.textContent = '';
        editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      });
    await receive('Hello after background consent was removed');
    await expect(
      panel.getByRole('textbox', { name: /^Live suggested reply/ }),
    ).toHaveValue('Hello!');
    await expect(chat.locator('#sent')).toHaveText('4');
    const stored = await options.evaluate(async () =>
      JSON.stringify(await chrome.storage.local.get(null)),
    );
    expect(stored).not.toContain('fixture-background-key');
    expect(stored).not.toContain('Hi again from the background');
  } finally {
    await context.close();
    await new Promise<void>((accept) => fixture.close(() => accept()));
    await backend.close();
    await rm(connectionFile, { force: true });
    await rmdir(connectionDirectory);
  }
});
