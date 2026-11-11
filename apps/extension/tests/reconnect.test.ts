import { describe, expect, it, vi } from 'vitest';
import { reconnectWhatsApp } from '../src/background/reconnect.js';

function setup(tabs = [{ id: 7, url: 'https://web.whatsapp.com/' }]) {
  const api = {
    tabs: {
      query: vi.fn().mockResolvedValue(tabs),
      sendMessage: vi.fn().mockResolvedValue({ ok: true }),
    },
    scripting: { executeScript: vi.fn().mockResolvedValue([]) },
  };
  return api;
}
describe('bounded WhatsApp bridge recovery', () => {
  it('resumes a healthy bridge on worker startup without resetting its live baseline', async () => {
    const api = setup();
    await reconnectWhatsApp(api, undefined, 'RESUME');
    expect(api.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(7, {
      type: 'ADAPTER_RESUME',
      version: 1,
    });
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });
  it('restores an older bridge that cannot resume, then uses the resume handshake', async () => {
    const api = setup();
    api.tabs.sendMessage.mockResolvedValueOnce({ ok: false });
    await reconnectWhatsApp(api, undefined, 'RESUME');
    expect(api.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(api.tabs.sendMessage.mock.calls.map((call) => call[1])).toEqual([
      { type: 'ADAPTER_RESUME', version: 1 },
      { type: 'ADAPTER_RESUME', version: 1 },
    ]);
  });
  it('resets a healthy bridge without injecting another observer', async () => {
    const api = setup();
    await reconnectWhatsApp(api);
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(7, {
      type: 'ADAPTER_RESET',
      version: 1,
    });
  });
  it('restores a missing or invalidated content script using the packaged file', async () => {
    const api = setup();
    api.tabs.sendMessage.mockRejectedValueOnce(
      new Error('Receiving end does not exist'),
    );
    await reconnectWhatsApp(api);
    expect(api.scripting.executeScript).toHaveBeenCalledExactlyOnceWith({
      target: { tabId: 7, frameIds: [0] },
      files: ['content.js'],
      world: 'ISOLATED',
    });
    expect(api.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });
  it('does not trust a failed bridge acknowledgement', async () => {
    const api = setup();
    api.tabs.sendMessage.mockResolvedValue({ ok: false });
    await expect(reconnectWhatsApp(api)).rejects.toThrow(
      'WHATSAPP_UNAVAILABLE',
    );
  });
  it('never injects into foreign, lookalike or fixture origins in production', async () => {
    const api = setup([
      { id: 8, url: 'https://web.whatsapp.com.example.com/' },
      { id: 9, url: 'http://127.0.0.1:4174/' },
    ]);
    await expect(reconnectWhatsApp(api)).rejects.toThrow(
      'WHATSAPP_UNAVAILABLE',
    );
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
    expect(api.tabs.sendMessage).not.toHaveBeenCalled();
  });
  it('reports denied host access and absence of tabs without touching other sites', async () => {
    const api = setup();
    api.tabs.sendMessage.mockRejectedValue(new Error('Missing receiver'));
    api.scripting.executeScript.mockRejectedValue(
      new Error('Cannot access contents'),
    );
    await expect(reconnectWhatsApp(api)).rejects.toThrow(
      'WHATSAPP_UNAVAILABLE',
    );
    const empty = setup([]);
    await expect(reconnectWhatsApp(empty)).rejects.toThrow(
      'WHATSAPP_UNAVAILABLE',
    );
    expect(empty.scripting.executeScript).not.toHaveBeenCalled();
  });
});
