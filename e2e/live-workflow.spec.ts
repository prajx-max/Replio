import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createBackend } from '../apps/api/dist/index.js';
import type { GenerationInput } from '../apps/api/src/providers/llm/provider.js';

test('paired adapter: draft-only insertion, recovery, opt-in auto-reply and chat pause', async () => {
  test.setTimeout(135000);
  const inputs: GenerationInput[] = [];
  let releaseFirstUnread = () => {};
  const firstUnreadReply = new Promise<void>((resolve) => {
    releaseFirstUnread = resolve;
  });
  const connectionDirectory = await mkdtemp(
    join(tmpdir(), 'assistant-browser-restart-'),
  );
  const connectionFile = join(connectionDirectory, '.env.connections');
  const createTestBackend = () =>
    createBackend({
      port: 4175,
      connectionFile,
      provider: {
        async generate(input) {
          inputs.push(input);
          for (const name of [
            'Lina',
            'Omar',
            'Already unread',
            'Waiting since yesterday',
          ]) {
            if (input.input.includes(name + ' asks for business hours')) {
              await firstUnreadReply;
              return {
                reply: 'Hello ' + name + '!',
                needsHuman: false,
                evidenceIds: ['business-information'],
              };
            }
          }
          if (input.input.includes('Unknown service question'))
            return {
              reply: 'An unsupported answer',
              needsHuman: true,
              evidenceIds: [],
            };
          if (input.input.includes('Multiline service question'))
            return {
              reply:
                'Hello! 👋\n\nChocolate Truffle Cake costs ₹650 for 500 grams.\nEggless is available.',
              needsHuman: false,
              evidenceIds: ['business-information'],
            };
          return input.input === 'Check connection.'
            ? { reply: 'Ready', needsHuman: true, evidenceIds: [] }
            : {
                reply:
                  'Chocolate Truffle Cake costs ₹650 for 500 grams. Eggless is available.',
                needsHuman: false,
                evidenceIds: ['business-information'],
              };
        },
      },
    });
  let backend = createTestBackend();
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
    fixture.listen(4174, '127.0.0.1', () => accept());
  });
  const browserPath = resolve('.browser-cache/chrome-win64/chrome.exe');
  const executablePath =
    process.env.CHROMIUM_EXECUTABLE_PATH ??
    (process.platform === 'win32' && existsSync(browserPath)
      ? browserPath
      : undefined);
  const extensionPath = resolve('apps/extension/dist-fixture');
  const context = await chromium.launchPersistentContext('', {
    ...(executablePath ? { executablePath } : { channel: 'chromium' }),
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  context.setDefaultTimeout(10000);
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).hostname;
    const setup = await context.newPage();
    let releaseSetup: () => void = () => undefined;
    const setupGate = new Promise<void>((accept) => {
      releaseSetup = accept;
    });
    await setup.route('**/setup/state?*', async (route) => {
      const response = await route.fetch();
      await setupGate;
      await route.fulfill({ response });
    });
    await setup.goto('http://127.0.0.1:4175/setup');
    await expect(setup.getByLabel('Model ID', { exact: true })).toBeDisabled();
    releaseSetup();
    await setup.getByLabel('AI provider', { exact: true }).selectOption('groq');
    await setup.getByLabel('Model ID', { exact: true }).fill('fixture-model');
    await setup
      .getByLabel('Model API key', { exact: true })
      .fill('fixture-provider-key-not-real');
    await expect(
      setup.getByRole('checkbox', { name: 'Remember connection on this PC' }),
    ).toBeChecked();
    await setup.getByRole('button', { name: /Save model connection/ }).click();
    await expect(
      setup.getByText('Model connection saved.', { exact: false }),
    ).toBeVisible();
    await expect(
      setup.getByLabel('Model API key', { exact: true }),
    ).toHaveValue('');
    const pairingCode = await setup
      .getByLabel('Extension pairing code')
      .inputValue();
    expect(pairingCode.length).toBeGreaterThan(32);
    await setup.getByRole('button', { name: 'Test model connection' }).click();
    await expect(setup.getByText(/Model connection works/)).toBeVisible();

    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await options
      .getByRole('textbox', { name: /^Reply instructions/ })
      .fill(
        'Reply politely. Keep replies concise. Use only confirmed business facts.',
      );
    await options
      .getByRole('textbox', { name: /^Business information/ })
      .fill(
        'Chocolate Truffle Cake costs ₹650 for 500 grams. Eggless is available.',
      );
    await options.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      options.getByText('Settings saved', { exact: true }),
    ).toBeVisible();
    await options
      .getByRole('textbox', { name: /^Backend pairing code/ })
      .fill(pairingCode);
    await options
      .getByRole('checkbox', {
        name: /^Suggest replies to new incoming messages/,
      })
      .check();
    await options
      .getByRole('button', { name: 'Connect AI backend', exact: true })
      .click();
    await expect(options.getByText('Connected', { exact: true })).toBeVisible();
    await expect(
      options.getByRole('textbox', { name: /^Backend pairing code/ }),
    ).toHaveValue('');
    const stored = await options.evaluate(async () =>
      JSON.stringify(await chrome.storage.local.get(null)),
    );
    expect(stored).not.toContain('fixture-provider-key-not-real');

    const chat = await context.newPage();
    await chat.goto(
      'http://127.0.0.1:4174/?themeRows&rewriteComposer&remountTail&inbox',
    );
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 420, height: 980 });
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);
    await expect(panel.getByText('Chat ready', { exact: true })).toBeVisible();
    expect(
      inputs.filter((entry) => entry.input !== 'Check connection.'),
    ).toHaveLength(0);
    await chat
      .getByRole('button', { name: 'Receive incoming message', exact: true })
      .click();
    await expect(
      panel.getByRole('textbox', { name: /^Live suggested reply/ }),
    ).toHaveValue(/₹650 for 500 grams/);
    const generated = inputs.filter(
      (entry) => entry.input !== 'Check connection.',
    );
    expect(generated).toHaveLength(1);
    expect(generated[0]?.system).toContain(
      'Reply politely. Keep replies concise.',
    );
    expect(generated[0]?.input).not.toContain('An old message already present');
    await options
      .getByText('Copy structural diagnostic report', { exact: true })
      .click();
    const report = await options
      .getByRole('textbox', {
        name: 'Structural diagnostic report',
        exact: true,
      })
      .inputValue();
    const metadata = JSON.parse(report) as {
      installedVersion: string;
      savedSelectorVersion: number;
      structure: {
        buildVersion: string;
        incomingNodesInList: number;
        textNodesInList: number;
      };
    };
    expect(metadata.installedVersion).toBe('0.7.3');
    expect(metadata.savedSelectorVersion).toBe(7);
    expect(metadata.structure.buildVersion).toBe('0.7.3');
    expect(metadata.structure.incomingNodesInList).toBeGreaterThan(0);
    expect(metadata.structure.textNodesInList).toBeGreaterThan(0);
    expect(report).not.toContain(
      'What is the price of Chocolate Truffle Cake?',
    );
    expect(report).not.toContain('fixture-provider-key-not-real');
    expect(report).not.toContain(pairingCode);
    await mkdir('artifacts/whatsapp-ai', { recursive: true });
    await panel.screenshot({
      path: 'artifacts/whatsapp-ai/live-workspace.png',
      fullPage: true,
    });
    await options.screenshot({
      path: 'artifacts/whatsapp-ai/business-settings.png',
      fullPage: true,
    });
    await setup.screenshot({
      path: 'artifacts/whatsapp-ai/key-setup.png',
      fullPage: true,
    });

    // Exercise the same trusted extension-page route with the fixture tab active.
    // Default Draft only writes the synthetic composer without clicking Send.
    const snapshot = await panel.evaluate(
      async () =>
        (await chrome.runtime.sendMessage({
          type: 'GET_STATE',
          version: 1,
        })) as {
          state: { live: { suggestion: { id: string; reply: string } } };
        },
    );
    await chat.bringToFront();
    const inserted = await panel.evaluate(
      async (suggestion) =>
        (await chrome.runtime.sendMessage({
          type: 'INSERT_LIVE_DRAFT',
          version: 1,
          suggestionId: suggestion.id,
          text: suggestion.reply,
          approval: 'EXPLICIT_USER_CLICK',
        })) as { ok: boolean },
      snapshot.state.live.suggestion,
    );
    expect(inserted.ok).toBe(true);
    await expect(
      chat.getByRole('textbox', { name: 'Message composer' }),
    ).toHaveText(/₹650\sfor\s500\sgrams/);
    await expect(chat.locator('#sent')).toHaveText('0');

    await chat
      .getByRole('button', { name: 'Duplicate last incoming node' })
      .click();
    await chat.getByRole('button', { name: 'Add outgoing message' }).click();
    await chat.getByRole('button', { name: 'Prepend older history' }).click();
    await chat.getByRole('button', { name: 'Switch chat' }).click();
    await expect(
      panel.getByRole('heading', { name: 'Fixture customer B', exact: true }),
    ).toBeVisible();
    await expect(panel.getByText('Chat ready', { exact: true })).toBeVisible();
    expect(
      inputs.filter((entry) => entry.input !== 'Check connection.'),
    ).toHaveLength(1);
    await expect(
      panel.getByRole('textbox', { name: /^Live suggested reply/ }),
    ).toHaveCount(0);
    const finalStorage = await options.evaluate(async () =>
      JSON.stringify(await chrome.storage.local.get(null)),
    );
    expect(finalStorage).not.toContain(
      'What is the price of Chocolate Truffle Cake?',
    );
    expect(finalStorage).not.toContain('fixture-provider-key-not-real');
    await options.setViewportSize({ width: 360, height: 950 });
    await expect
      .poll(() =>
        options.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      )
      .toBe(true);
    await options.screenshot({
      path: 'artifacts/whatsapp-ai/business-settings-mobile.png',
      fullPage: true,
    });

    // Simulate a missing receiver in the synthetic page, then recover through
    // the real trusted UI and packaged-script injection (no chat reload).
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:4174/*' });
      if (tab?.id === undefined) throw new Error('Missing synthetic tab');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        func: () => {
          const bridge = globalThis as typeof globalThis & {
            __universalAssistantDispose?: () => void;
          };
          bridge.__universalAssistantDispose?.();
        },
      });
    });
    await panel.evaluate(async () =>
      chrome.runtime.sendMessage({
        type: 'SET_ENABLED',
        version: 1,
        enabled: true,
      }),
    );
    await panel
      .getByRole('button', { name: 'Reconnect WhatsApp', exact: true })
      .click();
    await expect(panel.getByText('Chat ready', { exact: true })).toBeVisible();
    expect(
      inputs.filter((entry) => entry.input !== 'Check connection.'),
    ).toHaveLength(1);
    await chat
      .getByRole('button', { name: 'Receive incoming message', exact: true })
      .click();
    await expect(
      panel.getByRole('textbox', { name: /^Live suggested reply/ }),
    ).toHaveValue(/₹650 for 500 grams/);
    expect(
      inputs.filter((entry) => entry.input !== 'Check connection.'),
    ).toHaveLength(2);

    // Switch to a new chat to exercise automatic delivery without the earlier
    // chat's configured cooldown. No real WhatsApp account or model is used.
    await options.setViewportSize({ width: 1100, height: 950 });
    await options.getByRole('radio', { name: /^Auto-reply/ }).check();
    await options
      .getByRole('checkbox', {
        name: /^Allow automatic sending without review/,
      })
      .check();
    await options.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      options.getByText('Settings saved', { exact: true }),
    ).toBeVisible();
    await chat.bringToFront();
    await chat.getByRole('button', { name: 'Switch chat' }).click();
    await expect(
      panel.getByRole('heading', { name: 'Fixture customer C', exact: true }),
    ).toBeVisible();
    await expect(panel.getByText('Chat ready', { exact: true })).toBeVisible();
    await chat
      .getByRole('button', { name: 'Receive incoming message', exact: true })
      .click();
    await expect(chat.locator('#sent')).toHaveText('1');
    await expect(
      chat.getByRole('textbox', { name: 'Message composer' }),
    ).toBeEmpty();
    await expect(
      panel.getByRole('button', { name: 'Sent to WhatsApp', exact: true }),
    ).toBeDisabled();
    await expect(panel.getByText('Enabled', { exact: true })).toBeVisible();
    await panel.screenshot({
      path: 'artifacts/whatsapp-ai/auto-reply-sent.png',
      fullPage: true,
    });
    expect(
      inputs.filter((entry) => entry.input !== 'Check connection.'),
    ).toHaveLength(3);
    // Reproduce two messages arriving inside the real ten-second cooldown.
    // The packaged content bridge must advance the pending worker queue itself.
    async function stopExtensionWorker() {
      const lifecycle = await context.newCDPSession(panel);
      let workerVersion: string | undefined;
      let stopped = false;
      lifecycle.on(
        'ServiceWorker.workerVersionUpdated',
        (event: {
          versions: {
            versionId: string;
            scriptURL: string;
            runningStatus: string;
          }[];
        }) => {
          for (const version of event.versions)
            if (version.scriptURL === worker.url()) {
              workerVersion = version.versionId;
              if (version.runningStatus === 'stopped') stopped = true;
            }
        },
      );
      await lifecycle.send('ServiceWorker.enable');
      await expect.poll(() => workerVersion).toBeTruthy();
      if (!workerVersion)
        throw new Error('Missing synthetic extension worker version');
      stopped = false;
      await lifecycle.send('ServiceWorker.stopWorker', {
        versionId: workerVersion,
      });
      await expect.poll(() => stopped).toBe(true);
      await lifecycle.detach();
    }
    await stopExtensionWorker();
    await chat
      .getByRole('textbox', { name: 'Customer message' })
      .fill('First question in the burst');
    await chat
      .getByRole('button', { name: 'Receive incoming message', exact: true })
      .click();
    await expect(
      panel.getByRole('button', { name: 'Waiting to reply…', exact: true }),
    ).toBeDisabled();
    await chat
      .getByRole('textbox', { name: 'Customer message' })
      .fill('Latest question in the burst');
    await chat
      .getByRole('button', { name: 'Receive incoming message', exact: true })
      .click();
    await expect(
      panel.getByText('Latest question in the burst', { exact: true }),
    ).toBeVisible();
    await expect(chat.locator('#sent')).toHaveText('1');
    expect(
      inputs.filter((entry) => entry.input !== 'Check connection.'),
    ).toHaveLength(3);
    await panel.screenshot({
      path: 'artifacts/whatsapp-ai/cooldown-waiting.png',
      fullPage: true,
    });
    await expect(chat.locator('#sent')).toHaveText('2', { timeout: 20000 });
    await expect(
      panel.getByRole('button', { name: 'Sent to WhatsApp', exact: true }),
    ).toBeDisabled();
    expect(
      inputs.filter((entry) => entry.input !== 'Check connection.'),
    ).toHaveLength(4);
    expect(inputs.at(-1)?.input).toContain('Latest question in the burst');
    expect(inputs.at(-1)?.input).not.toContain('First question in the burst');
    await panel.screenshot({
      path: 'artifacts/whatsapp-ai/cooldown-sent.png',
      fullPage: true,
    });
    // Stop it again, then receive identical text with a fresh public ID in the
    // same chat. A successful second reply must not make the third one vanish.
    await stopExtensionWorker();
    await chat
      .getByRole('button', { name: 'Receive incoming message', exact: true })
      .click();
    await expect(chat.locator('#sent')).toHaveText('3', { timeout: 20000 });
    await expect(
      panel.getByRole('button', { name: 'Sent to WhatsApp', exact: true }),
    ).toBeDisabled();
    expect(
      inputs.filter((entry) => entry.input !== 'Check connection.'),
    ).toHaveLength(5);
    await panel.screenshot({
      path: 'artifacts/whatsapp-ai/repeated-replies-after-restart.png',
      fullPage: true,
    });
    // Restart the actual HTTP service with the saved backend environment file.
    // The existing extension pairing must work without reconnecting or refilling a key.
    await backend.close();
    backend = createTestBackend();
    await backend.listen();
    await setup.reload();
    await expect(setup.getByLabel('Extension pairing code')).toHaveValue(
      pairingCode,
    );
    await expect(
      setup.getByRole('checkbox', { name: 'Remember connection on this PC' }),
    ).toBeChecked();
    await expect(
      setup.getByLabel('Model API key', { exact: true }),
    ).toHaveValue('');
    await chat.bringToFront();
    await chat
      .getByRole('textbox', { name: 'Customer message' })
      .fill('New question after backend restart');
    await chat
      .getByRole('button', { name: 'Receive incoming message', exact: true })
      .click();
    await expect(chat.locator('#sent')).toHaveText('4', { timeout: 20000 });
    await expect(
      panel.getByRole('button', { name: 'Sent to WhatsApp', exact: true }),
    ).toBeDisabled();
    expect(
      inputs.filter((entry) => entry.input !== 'Check connection.'),
    ).toHaveLength(6);
    expect(inputs.at(-1)?.apiKey).toBe('fixture-provider-key-not-real');
    await panel.screenshot({
      path: 'artifacts/whatsapp-ai/reply-after-backend-restart.png',
      fullPage: true,
    });
    await chat
      .getByRole('button', { name: 'Duplicate last incoming node' })
      .click();
    await chat.getByRole('button', { name: 'Add outgoing message' }).click();
    await chat.getByRole('button', { name: 'Prepend older history' }).click();
    await expect(chat.locator('#sent')).toHaveText('4');

    await panel
      .getByRole('button', { name: 'Pause auto-reply for this chat' })
      .click();
    await expect(
      panel.getByText('Auto-reply paused for this chat', { exact: true }),
    ).toBeVisible();
    await chat.bringToFront();
    await chat
      .getByRole('button', { name: 'Receive incoming message', exact: true })
      .click();
    await expect(
      panel.getByRole('button', { name: 'Generate manual draft', exact: true }),
    ).toBeEnabled();
    expect(
      inputs.filter((entry) => entry.input !== 'Check connection.'),
    ).toHaveLength(6);
    await expect(chat.locator('#sent')).toHaveText('4');
    await panel
      .getByRole('button', { name: 'Resume auto-reply for this chat' })
      .click();
    await expect(panel.getByText(/Auto-reply active/)).toBeVisible();
    // Resuming does not replay the message received while paused.
    await expect(chat.locator('#sent')).toHaveText('4');
    await chat.bringToFront();
    await chat.getByRole('button', { name: 'Switch chat' }).click();
    await expect(
      panel.getByRole('heading', { name: 'Fixture customer D', exact: true }),
    ).toBeVisible();
    await expect(panel.getByText('Chat ready', { exact: true })).toBeVisible();
    await chat
      .getByRole('textbox', { name: 'Message composer' })
      .fill('My existing manual draft');
    await chat
      .getByRole('button', { name: 'Receive incoming message', exact: true })
      .click();
    await expect(
      panel.getByText(/The composer already contains text or was edited/),
    ).toBeVisible();
    await expect(
      chat.getByRole('textbox', { name: 'Message composer' }),
    ).toHaveText('My existing manual draft');
    await expect(chat.locator('#sent')).toHaveText('4');
    expect(
      inputs.filter((entry) => entry.input !== 'Check connection.'),
    ).toHaveLength(7);
    // Unknown facts create durable admin work before an automatic acknowledgement,
    // without inserting unsupported output or claiming a notification succeeded.
    await chat.getByRole('button', { name: 'Switch chat' }).click();
    await expect(
      panel.getByRole('heading', { name: 'Fixture customer E', exact: true }),
    ).toBeVisible();
    await expect(panel.getByText('Chat ready', { exact: true })).toBeVisible();
    await chat
      .getByRole('textbox', { name: 'Customer message' })
      .fill('Unknown service question');
    await chat
      .getByRole('button', { name: 'Receive incoming message', exact: true })
      .click();
    await expect(chat.locator('#sent')).toHaveText('5');
    await expect(
      panel.getByRole('heading', {
        name: 'Admin follow-up saved',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      panel.getByRole('textbox', { name: /^Live suggested reply/ }),
    ).toHaveValue(
      'I’ve added your request to the admin follow-up inbox for manual review.',
    );
    await panel.screenshot({
      path: 'artifacts/whatsapp-ai/automatic-fallback.png',
      fullPage: true,
    });

    // Real trusted editing cancels this transaction even if the visible draft
    // is later restored to the same words before Send becomes available.
    await chat.getByRole('button', { name: 'Switch chat' }).click();
    await expect(
      panel.getByRole('heading', { name: 'Fixture customer F', exact: true }),
    ).toBeVisible();
    await expect(panel.getByText('Chat ready', { exact: true })).toBeVisible();
    await chat
      .getByRole('checkbox', { name: 'Delay fixture Send button' })
      .check();
    await chat
      .getByRole('textbox', { name: 'Customer message' })
      .fill('Normal new service question');
    await chat
      .getByRole('button', { name: 'Receive incoming message', exact: true })
      .click();
    await expect(
      chat.getByRole('textbox', { name: 'Message composer' }),
    ).toHaveText(/₹650\sfor\s500\sgrams/);
    await chat
      .getByRole('textbox', { name: 'Message composer' })
      .fill('Operator editing this reply');
    await chat
      .getByRole('textbox', { name: 'Message composer' })
      .fill(
        'Chocolate Truffle Cake costs ₹650 for 500 grams. Eggless is available.',
      );
    await chat
      .getByRole('checkbox', { name: 'Delay fixture Send button' })
      .uncheck();
    await expect(
      panel.getByText(/The composer already contains text or was edited/),
    ).toBeVisible();
    await expect(chat.locator('#sent')).toHaveText('5');
    await chat.getByRole('button', { name: 'Switch chat' }).click();
    await expect(
      panel.getByRole('heading', { name: 'Fixture customer G', exact: true }),
    ).toBeVisible();
    await expect(panel.getByText('Chat ready', { exact: true })).toBeVisible();
    await chat
      .getByRole('textbox', { name: 'Customer message' })
      .fill('Multiline service question');
    await chat
      .getByRole('button', { name: 'Receive incoming message', exact: true })
      .click();
    await expect(chat.locator('#sent')).toHaveText('6');
    await expect(
      panel.getByRole('textbox', { name: /^Live suggested reply/ }),
    ).toHaveValue(
      'Hello! 👋\n\nChocolate Truffle Cake costs ₹650 for 500 grams.\nEggless is available.',
    );
    await options.setViewportSize({ width: 360, height: 950 });
    await expect
      .poll(() =>
        options.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      )
      .toBe(true);
    await options.screenshot({
      path: 'artifacts/whatsapp-ai/auto-reply-settings-mobile.png',
      fullPage: true,
    });
    const autoStorage = await options.evaluate(async () =>
      JSON.stringify(await chrome.storage.local.get(null)),
    );
    expect(autoStorage).toContain('SENT');
    expect(autoStorage).not.toContain(
      'What is the price of Chocolate Truffle Cake?',
    );
    const deliveries = await options.evaluate(async () =>
      JSON.stringify(
        await chrome.storage.local.get('assistant.webDelivery.v1'),
      ),
    );
    expect(deliveries).not.toContain('Chocolate Truffle Cake costs');
    await options.bringToFront();
    await options
      .getByRole('checkbox', { name: /^Open new unread chats automatically/ })
      .check();
    await options.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      options.getByText('Settings saved', { exact: true }),
    ).toBeVisible();
    await chat.bringToFront();
    await expect(
      panel.getByText('Watching the chat list for new unread messages.'),
    ).toBeVisible();
    await expect(panel.getByText('Chat ready', { exact: true })).toBeVisible();
    const beforeUnread = inputs.length;
    await chat
      .getByRole('button', { name: 'Receive unread messages in two chats' })
      .click();
    await expect.poll(() => inputs.length).toBe(beforeUnread + 1);
    const firstQuestion: unknown = JSON.parse(
      inputs[beforeUnread]!.input,
    ).customerMessage;
    expect([
      'Lina asks for business hours',
      'Omar asks for business hours',
    ]).toContain(firstQuestion);
    const firstName =
      firstQuestion === 'Lina asks for business hours' ? 'Lina' : 'Omar';
    const otherName = firstName === 'Lina' ? 'Omar' : 'Lina';
    await expect(chat.locator('#main header')).toHaveText(firstName);
    await expect(chat.locator('#pane-side .fixture-unread-badge')).toHaveCount(
      3,
    );
    await chat
      .getByRole('button', { name: 'Rerender queued chat rows' })
      .click();
    await expect(chat.locator('#inbox-replies li')).toHaveCount(0);
    releaseFirstUnread();
    await expect(chat.locator('#inbox-replies li')).toHaveText([
      `${firstName} — Hello ${firstName}!`,
      `${otherName} — Hello ${otherName}!`,
    ]);
    expect(
      inputs
        .slice(beforeUnread)
        .map((item) => JSON.parse(item.input).customerMessage),
    ).toEqual([
      `${firstName} asks for business hours`,
      `${otherName} asks for business hours`,
    ]);
    await expect(chat.locator('#pane-side .fixture-unread-badge')).toHaveCount(
      2,
    );
    await expect(
      chat
        .locator('#pane-side [role="listitem"]')
        .filter({ has: chat.locator('[title="Already unread"]') })
        .locator('.fixture-unread-badge'),
    ).toHaveCount(1);
    await expect(chat.locator('#sent')).toHaveText('8');
    // Hold the initial pass with a draft, then visit settings before any row
    // can open. Visibility loss used to silently discard both queued badges.
    await chat
      .locator('#main footer [contenteditable="true"]')
      .evaluate((editor) => {
        editor.textContent = 'Operator draft';
        editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      });
    await options.bringToFront();
    await options
      .getByRole('checkbox', { name: /^Include chats that are already unread/ })
      .check();
    await options.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      options.getByText('Settings saved', { exact: true }),
    ).toBeVisible();
    const beforeExisting = inputs.length;
    await chat.bringToFront();
    await expect(
      panel.getByText(/2 chats left.*finish the draft/),
    ).toBeVisible();
    // Headless Chromium keeps all pages visible even with focus emulation off.
    // Emulate the DOM visibility event in this fixture extension's isolated
    // world; production code and worker active-tab checks are unchanged.
    const tabVisibility = await context.newCDPSession(chat);
    let adapterWorld: number | undefined;
    tabVisibility.on(
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
          adapterWorld = world.id;
      },
    );
    await tabVisibility.send('Runtime.enable');
    await expect.poll(() => adapterWorld).toBeDefined();
    async function visibility(state: 'hidden' | 'visible') {
      if (adapterWorld === undefined)
        throw new Error('Missing synthetic adapter script context');
      const result = await tabVisibility.send('Runtime.evaluate', {
        contextId: adapterWorld,
        expression: `Object.defineProperty(document, 'visibilityState', { configurable: true, value: '${state}' }); document.dispatchEvent(new Event('visibilitychange')); document.visibilityState;`,
        returnByValue: true,
      });
      expect(result.exceptionDetails).toBeUndefined();
      expect(result.result.value).toBe(state);
    }
    await options.bringToFront();
    await visibility('hidden');
    await expect(
      panel.getByText(/Return to the WhatsApp tab.*2 chats left/),
    ).toBeVisible();
    expect(inputs.length).toBe(beforeExisting);
    const diagnosticReport = options.getByRole('textbox', {
      name: 'Structural diagnostic report',
      exact: true,
    });
    await expect
      .poll(async () => {
        const report = JSON.parse(await diagnosticReport.inputValue()) as {
          unreadSidebar: unknown;
        };
        return report.unreadSidebar;
      })
      .toMatchObject({
        visible: false,
        lastVisibleRows: 4,
        lastVisibleUnreadRows: 2,
        existingUnreadQueued: 2,
      });
    await chat
      .locator('#main footer [contenteditable="true"]')
      .evaluate((editor) => {
        editor.textContent = '';
        editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      });
    await chat.bringToFront();
    await visibility('visible');
    // Both badges predate consent. No new incoming action or chat selection.
    await expect(chat.locator('#inbox-replies li')).toHaveText(
      [
        `${firstName} — Hello ${firstName}!`,
        `${otherName} — Hello ${otherName}!`,
        'Already unread — Hello Already unread!',
        'Waiting since yesterday — Hello Waiting since yesterday!',
      ],
      { timeout: 20000 },
    );
    expect(
      inputs
        .slice(beforeExisting)
        .map((item) => JSON.parse(item.input).customerMessage),
    ).toEqual([
      'Already unread asks for business hours',
      'Waiting since yesterday asks for business hours',
    ]);
    await expect(chat.locator('#pane-side .fixture-unread-badge')).toHaveCount(
      0,
    );
    await expect(chat.locator('#sent')).toHaveText('10');

    // Callback requests create the same durable admin work without a paid model
    // call. The admin can progress/resolve it and retain state after worker exit.
    await chat.getByRole('button', { name: 'Switch chat' }).click();
    await expect(
      panel.getByRole('heading', { name: 'Fixture customer H', exact: true }),
    ).toBeVisible();
    await expect(panel.getByText('Chat ready', { exact: true })).toBeVisible();
    const beforeCallback = inputs.length;
    await chat
      .getByRole('textbox', { name: 'Customer message' })
      .fill('Please call me');
    await chat
      .getByRole('button', { name: 'Receive incoming message', exact: true })
      .click();
    await expect(chat.locator('#sent')).toHaveText('11');
    await expect(
      panel.getByRole('heading', {
        name: 'Admin follow-up saved',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      panel.getByRole('textbox', { name: /^Live suggested reply/ }),
    ).toHaveValue(
      'I’ve added your request to the admin follow-up inbox for manual review.',
    );
    expect(inputs).toHaveLength(beforeCallback);
    await options.bringToFront();
    await options.setViewportSize({ width: 1100, height: 950 });
    const followups = options.getByRole('region', { name: 'Admin follow-ups' });
    const callback = followups.getByRole('article', {
      name: 'Fixture customer H',
      exact: true,
    });
    await expect(
      callback.getByText('Callback requested', { exact: true }),
    ).toBeVisible();
    await expect(
      callback.getByText(
        'Customer question not stored. Review the conversation in WhatsApp.',
      ),
    ).toBeVisible();
    const unresolved = followups.getByRole('article', {
      name: 'Fixture customer E',
      exact: true,
    });
    await expect(
      unresolved.getByText('Needs an answer', { exact: true }),
    ).toBeVisible();
    await callback
      .getByRole('button', { name: 'Mark in progress', exact: true })
      .click();
    await followups.getByLabel('Show follow-ups').selectOption('IN_PROGRESS');
    await expect(
      callback.getByText('In progress', { exact: true }),
    ).toBeVisible();
    await callback
      .getByRole('button', { name: 'Resolve', exact: true })
      .click();
    await followups.getByLabel('Show follow-ups').selectOption('RESOLVED');
    await expect(callback.getByText('Resolved', { exact: true })).toBeVisible();

    // Raw question storage remains an explicit local privacy choice.
    const saveQuestions = options.getByRole('checkbox', {
      name: /^Save customer questions in follow-ups on this PC/,
    });
    await expect(saveQuestions).not.toBeChecked();
    await saveQuestions.check();
    await options.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      options.getByText('Settings saved', { exact: true }),
    ).toBeVisible();
    await chat.bringToFront();
    await chat.getByRole('button', { name: 'Switch chat' }).click();
    await expect(
      panel.getByRole('heading', { name: 'Fixture customer I', exact: true }),
    ).toBeVisible();
    await expect(panel.getByText('Chat ready', { exact: true })).toBeVisible();
    const storedQuestion = 'Please call me about my delivery';
    await chat
      .getByRole('textbox', { name: 'Customer message' })
      .fill(storedQuestion);
    await chat
      .getByRole('button', { name: 'Receive incoming message', exact: true })
      .click();
    await expect(chat.locator('#sent')).toHaveText('12');
    expect(inputs).toHaveLength(beforeCallback);
    await stopExtensionWorker();
    await options.bringToFront();
    await options.reload();
    await followups.getByLabel('Show follow-ups').selectOption('ALL');
    await expect(callback.getByText('Resolved', { exact: true })).toBeVisible();
    const retained = followups.getByRole('article', {
      name: 'Fixture customer I',
      exact: true,
    });
    await expect(
      retained.getByText(storedQuestion, { exact: true }),
    ).toBeVisible();
    await expect(
      unresolved.getByText('Needs an answer', { exact: true }),
    ).toBeVisible();
    const handoffStorage = await options.evaluate(async () =>
      JSON.stringify(await chrome.storage.local.get('assistant.handoffs.v1')),
    );
    expect(handoffStorage).toContain(storedQuestion);
    expect(handoffStorage).not.toContain('Unknown service question');
    expect(handoffStorage).not.toContain('"question":"Please call me"');
    await saveQuestions.uncheck();
    await options.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      options.getByText('Settings saved', { exact: true }),
    ).toBeVisible();
    await expect(
      retained.getByText(storedQuestion, { exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(async () =>
        options.evaluate(async () =>
          JSON.stringify(
            await chrome.storage.local.get('assistant.handoffs.v1'),
          ),
        ),
      )
      .not.toContain(storedQuestion);
    await followups.screenshot({
      path: 'artifacts/whatsapp-ai/admin-followups.png',
    });

    // Only an explicit business commitment enables the operator's saved reply.
    // The new acknowledgement still requires a durable callback record and
    // uses no provider call. Disabling commitment restores the fixed reply.
    const customReply = 'Our team will reach out to you soon.';
    const replyField = options.getByRole('textbox', {
      name: 'Saved follow-up reply',
      exact: true,
    });
    const commitment = options.getByRole('checkbox', {
      name: 'Our team will handle saved follow-ups and contact customers as promised',
      exact: true,
    });
    await expect(replyField).toHaveValue('');
    await expect(commitment).not.toBeChecked();
    await options
      .getByRole('button', { name: 'Use suggested reply', exact: true })
      .click();
    await expect(replyField).toHaveValue(customReply);
    await commitment.check();
    await options.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      options.getByText('Settings saved', { exact: true }),
    ).toBeVisible();
    await options.reload();
    await expect(replyField).toHaveValue(customReply);
    await expect(commitment).toBeChecked();

    await chat.bringToFront();
    await chat.getByRole('button', { name: 'Switch chat' }).click();
    await expect(
      panel.getByRole('heading', { name: 'Fixture customer J', exact: true }),
    ).toBeVisible();
    await expect(panel.getByText('Chat ready', { exact: true })).toBeVisible();
    await chat
      .getByRole('textbox', { name: 'Customer message' })
      .fill('Please call me');
    await chat
      .getByRole('button', { name: 'Receive incoming message', exact: true })
      .click();
    await expect(chat.locator('#sent')).toHaveText('13');
    await expect(
      panel.getByRole('textbox', { name: /^Live suggested reply/ }),
    ).toHaveValue(customReply);
    expect(inputs).toHaveLength(beforeCallback);
    await options.bringToFront();
    await followups.getByLabel('Show follow-ups').selectOption('ALL');
    const customCallback = followups.getByRole('article', {
      name: 'Fixture customer J',
      exact: true,
    });
    await expect(
      customCallback.getByText('Callback requested', { exact: true }),
    ).toBeVisible();
    await options
      .getByRole('region', { name: 'Follow-up reply', exact: true })
      .screenshot({
        path: 'artifacts/whatsapp-ai/custom-followup-reply.png',
      });

    await commitment.uncheck();
    await options.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      options.getByText('Settings saved', { exact: true }),
    ).toBeVisible();
    await expect(replyField).toHaveValue(customReply);
    await chat.bringToFront();
    await chat.getByRole('button', { name: 'Switch chat' }).click();
    await expect(
      panel.getByRole('heading', { name: 'Fixture customer K', exact: true }),
    ).toBeVisible();
    await expect(panel.getByText('Chat ready', { exact: true })).toBeVisible();
    await chat
      .getByRole('textbox', { name: 'Customer message' })
      .fill('Please call me');
    await chat
      .getByRole('button', { name: 'Receive incoming message', exact: true })
      .click();
    await expect(chat.locator('#sent')).toHaveText('14');
    await expect(
      panel.getByRole('textbox', { name: /^Live suggested reply/ }),
    ).toHaveValue(
      'I’ve added your request to the admin follow-up inbox for manual review.',
    );
    expect(inputs).toHaveLength(beforeCallback);
  } finally {
    releaseFirstUnread();
    await context.close();
    await backend.close();
    fixture.closeAllConnections();
    await new Promise<void>((accept) => fixture.close(() => accept()));
    await rm(connectionDirectory, { recursive: true, force: true });
  }
});
