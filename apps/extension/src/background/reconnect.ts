import { z } from 'zod';
import { AdapterControlSchema } from '@assistant/contracts';
import type { AdapterControl } from '@assistant/contracts';

export interface RecoveryApi {
  tabs: {
    query(query: {
      url: string[];
    }): Promise<{ id?: number | undefined; url?: string | undefined }[]>;
    sendMessage(tabId: number, message: AdapterControl): Promise<unknown>;
  };
  scripting: {
    executeScript(options: {
      target: { tabId: number; frameIds: number[] };
      files: string[];
      world: 'ISOLATED';
    }): Promise<unknown>;
  };
}
const acknowledgement = z.strictObject({ ok: z.literal(true) });

export async function reconnectWhatsApp(
  api: RecoveryApi,
  fixtureOrigin?: 'http://127.0.0.1:4174',
  mode: 'RESET' | 'RESUME' = 'RESET',
): Promise<void> {
  const message = AdapterControlSchema.parse({
    type: mode === 'RESUME' ? 'ADAPTER_RESUME' : 'ADAPTER_RESET',
    version: 1,
  });
  const origins = [
    'https://web.whatsapp.com',
    ...(fixtureOrigin ? [fixtureOrigin] : []),
  ];
  const tabs = await api.tabs.query({
    url: origins.map((origin) => `${origin}/*`),
  });
  const candidates = tabs.filter((tab) => {
    try {
      return (
        tab.id !== undefined && origins.includes(new URL(tab.url ?? '').origin)
      );
    } catch {
      return false;
    }
  });
  if (!candidates.length) throw new Error('WHATSAPP_UNAVAILABLE');
  const results = await Promise.allSettled(
    candidates.map(async (tab) => {
      const tabId = tab.id;
      if (tabId === undefined) return;
      try {
        if (
          acknowledgement.safeParse(await api.tabs.sendMessage(tabId, message))
            .success
        )
          return;
      } catch {
        /* An old or absent content script needs the packaged adapter. */
      }
      await api.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        files: ['content.js'],
        world: 'ISOLATED',
      });
      if (
        !acknowledgement.safeParse(await api.tabs.sendMessage(tabId, message))
          .success
      )
        throw new Error('WHATSAPP_UNAVAILABLE');
    }),
  );
  if (!results.some((result) => result.status === 'fulfilled'))
    throw new Error('WHATSAPP_UNAVAILABLE');
}
