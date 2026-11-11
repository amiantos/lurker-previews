// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from './server.js';
import { superviseContainment } from './selfTest.js';

vi.mock('./server.js', () => ({ createServer: vi.fn<typeof createServer>() }));
vi.mock('./selfTest.js', () => ({ superviseContainment: vi.fn<typeof superviseContainment>() }));
vi.mock('./utils/env.js', () => ({
  envInt: (name: string, fallback: number) => (name === 'PORT' ? 0 : fallback),
}));

let server: http.Server;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  server = http.createServer((_req, res) => res.end('ok'));
  vi.mocked(createServer).mockReturnValue(server);
});

afterEach(async () => {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function boot(host: string | undefined): Promise<AddressInfo> {
  vi.stubEnv('HOST', host);
  const listening = new Promise<AddressInfo>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve(server.address() as AddressInfo));
  });
  await import('./index.js');
  return listening;
}

describe('listen host', () => {
  it('binds to IPv4 loopback and logs the actual endpoint', async () => {
    const address = await boot('127.0.0.1');
    expect(address.address).toBe('127.0.0.1');
    expect(address.port).toBeGreaterThan(0);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(`listening on 127.0.0.1:${address.port} (not ready)`),
    );
    expect(superviseContainment).toHaveBeenCalledOnce();
  });

  it.each([undefined, ''])('preserves wildcard binding for HOST=%s', async (host) => {
    const address = await boot(host);
    expect(['::', '0.0.0.0']).toContain(address.address);
    expect(superviseContainment).toHaveBeenCalledOnce();
  });

  it('binds to IPv6 loopback and brackets the logged address', async (context) => {
    let address: AddressInfo;
    try {
      address = await boot('::1');
    } catch (error) {
      if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        context.skip('IPv6 loopback is unavailable');
        return;
      }
      throw error;
    }
    expect(address.address).toBe('::1');
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(`listening on [::1]:${address.port} (not ready)`),
    );
    expect(superviseContainment).toHaveBeenCalledOnce();
  });

  it('fails an invalid host without starting containment supervision', async () => {
    // ENOTFOUND with a resolver to ask; EAI_AGAIN where there is none (an offline build).
    await expect(boot('invalid host!')).rejects.toMatchObject({
      code: expect.stringMatching(/^(ENOTFOUND|EAI_AGAIN)$/),
    });
    expect(server.listening).toBe(false);
    expect(superviseContainment).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });
});
