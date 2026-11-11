import { test, expect, chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createBackend } from '../apps/api/dist/index.js';
import { HttpLlmProvider } from '../apps/api/dist/providers/llm/provider.js';

test('provider setup: presets, custom destination, JSON compatibility and remembered restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'replio-provider-setup-'));
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let fail = false;
  const provider = new HttpLlmProvider(async (url, init) => {
    calls.push({
      url,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return fail
      ? new Response('private upstream error', { status: 401 })
      : Response.json({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  reply: 'Ready',
                  needsHuman: true,
                  evidenceIds: [],
                }),
              },
            },
          ],
        });
  });
  const create = (port: number) =>
    createBackend({
      port,
      connectionFile: join(directory, '.env.connections'),
      provider,
    });
  let backend = create(0);
  const origin = await backend.listen();
  const browserPath = resolve('.browser-cache/chrome-win64/chrome.exe');
  const executablePath =
    process.env.CHROMIUM_EXECUTABLE_PATH ??
    (process.platform === 'win32' && existsSync(browserPath)
      ? browserPath
      : undefined);
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : { channel: 'chromium' }),
    headless: true,
  });
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/setup?profileId=provider-test`);
    const selection = page.getByLabel('AI provider', { exact: true });
    const model = page.getByLabel('Model ID', { exact: true });
    const key = page.getByLabel('Model API key', { exact: true });
    const base = page.getByLabel('API base URL', { exact: true });
    const format = page.getByLabel('Response format', { exact: true });
    const save = page.getByRole('button', { name: /Save model connection/ });
    const check = page.getByRole('button', { name: 'Test model connection' });
    await expect(selection).toBeEnabled();
    for (const native of ['openai', 'gemini', 'anthropic']) {
      await selection.selectOption(native);
      await expect(base).toBeHidden();
      await expect(format).toBeHidden();
    }
    await page.getByLabel('Remember connection on this PC').uncheck();
    for (const name of [
      'groq',
      'deepseek',
      'openrouter',
      'mistral',
      'xai',
      'together',
    ]) {
      await selection.selectOption(name);
      await expect(base).toBeHidden();
      await expect(format).toBeVisible();
      await model.fill('vendor/fixture-model');
      await key.fill('fixture-provider-key-not-real');
      await save.click();
      await expect(page.getByText(/Model connection saved/)).toBeVisible();
      await expect(key).toHaveValue('');
      await check.click();
      await expect(page.getByText(/Model connection works/)).toBeVisible();
      expect(calls.at(-1)?.body.model).toBe('vendor/fixture-model');
      expect(calls.at(-1)?.body.response_format).toEqual({
        type: 'json_object',
      });
    }
    await selection.selectOption('custom');
    await expect(base).toBeVisible();
    await base.fill('https://models.example.com/v1/');
    await model.fill('vendor/fixture-model');
    await format.selectOption('text');
    await key.fill('fixture-custom-key-not-real');
    await page.getByLabel('Remember connection on this PC').check();
    await save.click();
    await expect(page.getByText(/Model connection saved/)).toBeVisible();
    const pairing = await page
      .getByLabel('Extension pairing code')
      .inputValue();
    await check.click();
    await expect(page.getByText(/Model connection works/)).toBeVisible();
    expect(calls.at(-1)?.url).toBe(
      'https://models.example.com/v1/chat/completions',
    );
    expect(calls.at(-1)?.body).not.toHaveProperty('response_format');
    await backend.close();
    backend = create(Number(new URL(origin).port));
    await backend.listen();
    await page.reload();
    await expect(selection).toHaveValue('custom');
    await expect(base).toHaveValue('https://models.example.com/v1');
    await expect(format).toHaveValue('text');
    await expect(page.getByLabel('Extension pairing code')).toHaveValue(
      pairing,
    );
    await expect(key).toHaveValue('');
    await check.click();
    await expect(page.getByText(/Model connection works/)).toBeVisible();

    // A destination change must never reuse the old destination's credential.
    const previousCalls = calls.length;
    await base.fill('https://different.example.com/v1');
    await save.click();
    await expect(page.locator('#message')).toHaveClass('error');
    expect(calls).toHaveLength(previousCalls);
    await page.reload();
    await expect(base).toHaveValue('https://models.example.com/v1');
    await expect(page.getByLabel('Extension pairing code')).toHaveValue(
      pairing,
    );
    fail = true;
    await check.click();
    await expect(page.getByText(/rejected the API key/)).toBeVisible();
    await expect(page.locator('body')).not.toContainText(
      'private upstream error',
    );
    fail = false;
    await check.click();
    await expect(page.getByText(/Model connection works/)).toBeVisible();
    await mkdir('artifacts/whatsapp-ai', { recursive: true });
    await page.screenshot({
      path: 'artifacts/whatsapp-ai/custom-provider-setup.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 360, height: 800 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(360);
    await page.screenshot({
      path: 'artifacts/whatsapp-ai/custom-provider-mobile.png',
      fullPage: true,
    });
  } finally {
    await browser.close();
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});
