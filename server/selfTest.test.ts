// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The self-test's own test, over real sockets on loopback. The property being
// pinned: a COMPLETED connect is a failure, and nothing else is — a refusal
// (RST from a closed port) must pass, because under the DROP rules a deployment
// ships, "refused" can only mean a live host answered, and a live host we can
// reach at all is what the metadata probe already covers.

import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { probeConnects, probeTargets, runSelfTest } from './selfTest.js';

async function listening(): Promise<{ target: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => res.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    target: `127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('probeConnects', () => {
  it('reports a listening target as reachable — the failure signal', async () => {
    const srv = await listening();
    try {
      expect(await probeConnects(srv.target)).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('reports a closed port as unreachable — a refusal is a pass', async () => {
    const srv = await listening();
    await srv.close(); // the port is now provably closed, not merely unused
    expect(await probeConnects(srv.target)).toBe(false);
  });

  it('treats a malformed target as unreachable rather than crashing the boot', async () => {
    expect(await probeConnects('not-a-target')).toBe(false);
    expect(await probeConnects('127.0.0.1:notaport')).toBe(false);
  });
});

describe('runSelfTest', () => {
  it('fails, naming the hole, when any probe connects', async () => {
    const srv = await listening();
    try {
      const result = await runSelfTest([srv.target], {} as NodeJS.ProcessEnv);
      expect(result.passed).toBe(false);
      expect(result.reachable).toEqual([srv.target]);
    } finally {
      await srv.close();
    }
  });

  it('passes when every probe is unreachable', async () => {
    const srv = await listening();
    await srv.close();
    const result = await runSelfTest([srv.target], {} as NodeJS.ProcessEnv);
    expect(result.passed).toBe(true);
    expect(result.reachable).toEqual([]);
  });

  it('skips only under the explicit dev escape hatch, and says so', async () => {
    const srv = await listening();
    try {
      const result = await runSelfTest([srv.target], {
        LURKER_PREVIEWS_ALLOW_PRIVATE: '1',
      } as NodeJS.ProcessEnv);
      expect(result.passed).toBe(true);
      expect(result.skipped).toBe(true);
    } finally {
      await srv.close();
    }
  });
});

describe('probeTargets', () => {
  it('always includes the cloud metadata service', () => {
    expect(probeTargets({} as NodeJS.ProcessEnv)).toContain('169.254.169.254:80');
  });

  it('adds operator-supplied known-listening targets from the env', () => {
    // ⚠ These are the strong probes: a default nothing listens at passes whether the firewall
    // exists or not, so hosted deployments name the cell's own VPC address here.
    const targets = probeTargets({
      LURKER_PREVIEWS_SELFTEST_TARGETS: '10.0.0.5:8015, 10.0.0.1:22',
    } as NodeJS.ProcessEnv);
    expect(targets).toContain('10.0.0.5:8015');
    expect(targets).toContain('10.0.0.1:22');
  });
});
