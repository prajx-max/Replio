import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import type { LookupAddress, LookupAllOptions } from 'node:dns';
import { request } from 'node:https';
import { IncomingMessage, type ClientRequest } from 'node:http';
import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import {
  customProviderFetch,
  isPublicProviderAddress,
  pinnedProviderLookup,
} from '../src/providers/llm/public-endpoint.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));
const lookupAll: (
  hostname: string,
  options: LookupAllOptions,
) => Promise<LookupAddress[]> = lookup;
const mockedLookup = vi.mocked(lookupAll);
const url = 'https://models.example.com/v1/chat/completions';
const init: RequestInit = {
  method: 'POST',
  body: '{}',
  headers: { Authorization: 'Bearer fixture-key' },
};

function mockResponse(status: number, body: string) {
  const outgoing = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    destroy: vi.fn(),
  });
  vi.mocked(request).mockImplementation((_url, _options, callback) => {
    queueMicrotask(() => {
      const incoming = new IncomingMessage(new Socket());
      incoming.statusCode = status;
      callback?.(incoming);
      incoming.push(Buffer.from(body));
      incoming.push(null);
    });
    // A minimal event-only socket substitute: no test opens a network connection.
    return outgoing as unknown as ClientRequest;
  });
  return outgoing;
}

describe('custom public HTTPS transport', () => {
  beforeEach(() => {
    mockedLookup.mockReset();
    vi.mocked(request).mockReset();
    mockedLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  });
  it.each([
    '127.0.0.1',
    '10.1.1.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '224.1.1.1',
    '240.0.0.1',
    '::1',
    '::ffff:8.8.8.8',
    'fc00::1',
    'fe80::1',
    '64:ff9b::7f00:1',
    '2001:db8::1',
    '2001::1',
    '2002:7f00:1::1',
    '3fff::1',
  ])('rejects nonpublic/special address %s', async (address) => {
    expect(isPublicProviderAddress(address)).toBe(false);
    mockedLookup.mockResolvedValue([
      { address, family: address.includes(':') ? 6 : 4 },
    ]);
    await expect(customProviderFetch(url, init)).rejects.toThrow(
      'ENDPOINT_REJECTED',
    );
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects mixed public and private DNS answers', async () => {
    mockedLookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(customProviderFetch(url, init)).rejects.toThrow(
      'ENDPOINT_REJECTED',
    );
    expect(request).not.toHaveBeenCalled();
  });
  it('pins the validated public address and retains TLS server name and verification', async () => {
    const outgoing = mockResponse(200, '{"ok":true}');
    expect(await (await customProviderFetch(url, init)).json()).toEqual({
      ok: true,
    });
    expect(lookup).toHaveBeenCalledExactlyOnceWith('models.example.com', {
      all: true,
      verbatim: true,
    });
    const options = vi.mocked(request).mock.calls[0]?.[1];
    expect(options).toMatchObject({
      agent: false,
      servername: 'models.example.com',
      rejectUnauthorized: true,
      family: 4,
    });
    const callback = vi.fn();
    options?.lookup?.('models.example.com', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [
      { address: '8.8.8.8', family: 4 },
    ]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(outgoing.end).toHaveBeenCalledWith('{}');
  });
  it('accepts public IPv6 and pins both lookup invocation shapes', () => {
    expect(isPublicProviderAddress('2606:4700::1111')).toBe(true);
    const callback = vi.fn();
    pinnedProviderLookup('2606:4700::1111', 6)(
      'models.example.com',
      {},
      callback,
    );
    expect(callback).toHaveBeenCalledWith(null, '2606:4700::1111', 6);
  });
  it('resolves again on the next request and blocks a rebinding answer', async () => {
    mockResponse(200, '{}');
    await customProviderFetch(url, init);
    mockedLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(customProviderFetch(url, init)).rejects.toThrow(
      'ENDPOINT_REJECTED',
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects redirects without following Location or exposing response text', async () => {
    mockResponse(302, 'private diagnostics');
    await expect(customProviderFetch(url, init)).rejects.toThrow(
      'ENDPOINT_REJECTED',
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('bounds bytes received and destroys an oversized response', async () => {
    const outgoing = mockResponse(200, 'x'.repeat(65537));
    await expect(customProviderFetch(url, init)).rejects.toThrow(
      'INVALID_OUTPUT',
    );
    expect(outgoing.destroy).toHaveBeenCalled();
  });
  it('drops upstream error body before returning status', async () => {
    mockResponse(401, 'private diagnostics');
    const response = await customProviderFetch(url, init);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('');
  });
  it('does not connect after abort during DNS', async () => {
    let finish:
      ((value: { address: string; family: number }[]) => void) | undefined;
    mockedLookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const result = customProviderFetch(url, {
      ...init,
      signal: controller.signal,
    });
    controller.abort();
    await expect(result).rejects.toThrow('PROVIDER_UNAVAILABLE');
    finish?.([{ address: '8.8.8.8', family: 4 }]);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
  });
  it('sanitizes DNS errors', async () => {
    mockedLookup.mockRejectedValue(new Error('private system data'));
    await expect(customProviderFetch(url, init)).rejects.toThrow(
      'PROVIDER_UNAVAILABLE',
    );
  });
  it('rejects an empty DNS answer without opening a socket', async () => {
    mockedLookup.mockResolvedValue([]);
    await expect(customProviderFetch(url, init)).rejects.toThrow(
      'ENDPOINT_REJECTED',
    );
    expect(request).not.toHaveBeenCalled();
  });
  it('sanitizes socket and TLS errors', async () => {
    const outgoing = Object.assign(new EventEmitter(), {
      end: vi.fn(() =>
        queueMicrotask(() =>
          outgoing.emit('error', new Error('private TLS diagnostics')),
        ),
      ),
    });
    vi.mocked(request).mockReturnValue(outgoing as unknown as ClientRequest);
    await expect(customProviderFetch(url, init)).rejects.toThrow(
      'PROVIDER_UNAVAILABLE',
    );
  });
  it('rejects bad endpoint syntax before DNS', async () => {
    await expect(
      customProviderFetch(
        'https://user:secret@models.example.com/v1/chat/completions',
        init,
      ),
    ).rejects.toThrow('ENDPOINT_REJECTED');
    expect(lookup).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
