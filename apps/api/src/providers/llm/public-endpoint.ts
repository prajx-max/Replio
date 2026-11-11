import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { CustomProviderBaseUrlSchema } from '@assistant/contracts';
import { ServiceFailure } from './failure.js';
import type { ProviderFetch } from './provider.js';

// Conservatively exclude special-use ranges, including transition mechanisms.
// Public hosts are re-resolved for every request; no environment proxy is used.
const excluded = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  excluded.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2620:4f:8000::', 48],
  ['3fff::', 20],
] as const)
  excluded.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicProviderAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !excluded.check(address, 'ipv4');
  return (
    family === 6 &&
    globalV6.check(address, 'ipv6') &&
    !excluded.check(address, 'ipv6')
  );
}

export function pinnedProviderLookup(
  address: string,
  family: number,
): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/** Only the custom adapter uses this transport. Validation and connecting share
 * the same DNS result, while TLS/Host continue to use the original hostname. */
export const customProviderFetch: ProviderFetch = async (rawUrl, init) => {
  const suffix = '/chat/completions';
  const parsed = rawUrl.endsWith(suffix)
    ? CustomProviderBaseUrlSchema.safeParse(rawUrl.slice(0, -suffix.length))
    : undefined;
  if (!parsed?.success || rawUrl !== `${parsed.data}${suffix}`)
    throw new ServiceFailure('ENDPOINT_REJECTED');
  const url = new URL(rawUrl);
  if (init.method !== 'POST' || typeof init.body !== 'string')
    throw new ServiceFailure('INVALID_REQUEST');
  const body = init.body;
  const headers = Object.fromEntries(new Headers(init.headers));
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(20000)])
    : AbortSignal.timeout(20000);
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (error?: ServiceFailure, result?: Response) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const abort = () => finish(new ServiceFailure('PROVIDER_UNAVAILABLE'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    void lookup(url.hostname, { all: true, verbatim: true })
      .then((addresses) => {
        if (settled || signal.aborted) return;
        if (
          !addresses.length ||
          addresses.some(
            ({ address, family }) =>
              !isPublicProviderAddress(address) || isIP(address) !== family,
          )
        ) {
          finish(new ServiceFailure('ENDPOINT_REJECTED'));
          return;
        }
        const selected = addresses[0];
        if (!selected) {
          finish(new ServiceFailure('ENDPOINT_REJECTED'));
          return;
        }
        const outgoing = request(
          url,
          {
            method: 'POST',
            headers,
            signal,
            agent: false,
            servername: url.hostname,
            rejectUnauthorized: true,
            family: selected.family,
            lookup: pinnedProviderLookup(selected.address, selected.family),
          },
          (incoming) => {
            const status = incoming.statusCode ?? 502;
            if (status >= 300 && status < 400) {
              incoming.destroy();
              finish(new ServiceFailure('ENDPOINT_REJECTED'));
              return;
            }
            if (status < 200 || status >= 300) {
              incoming.destroy();
              finish(undefined, new Response(null, { status }));
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            incoming.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > 65536) {
                finish(new ServiceFailure('INVALID_OUTPUT'));
                incoming.destroy();
                outgoing.destroy();
              } else chunks.push(chunk);
            });
            incoming.on('error', () =>
              finish(new ServiceFailure('PROVIDER_UNAVAILABLE')),
            );
            incoming.on('aborted', () =>
              finish(new ServiceFailure('PROVIDER_UNAVAILABLE')),
            );
            incoming.on('end', () =>
              finish(
                undefined,
                new Response(
                  status === 204 || status === 205
                    ? null
                    : Buffer.concat(chunks),
                  { status },
                ),
              ),
            );
          },
        );
        outgoing.on('error', () =>
          finish(new ServiceFailure('PROVIDER_UNAVAILABLE')),
        );
        outgoing.end(body);
      })
      .catch(() => finish(new ServiceFailure('PROVIDER_UNAVAILABLE')));
  });
};
