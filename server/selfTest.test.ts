// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The self-test's own test, over real sockets on loopback. The property being
// pinned: a COMPLETED connect is a failure, and nothing else is — a refusal
// (RST from a closed port) must pass, because under the DROP rules a deployment
// ships, "refused" can only mean a live host answered, and a live host we can
// reach at all is what the metadata probe already covers.

import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  gatewayTargetsFrom,
  parseTarget,
  probeConnects,
  probeTargets,
  runSelfTest,
  superviseContainment,
} from './selfTest.js';

async function listening(
  host = '127.0.0.1',
): Promise<{ target: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => res.end());
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    target: host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Can this machine listen on IPv6 loopback at all? (A CI runner without ::1 skips.) */
const ipv6Here = await new Promise<boolean>((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(0, '::1', () => s.close(() => resolve(true)));
});

afterEach(() => vi.restoreAllMocks());

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

  it.skipIf(!ipv6Here)('probes a bracketed IPv6 target over IPv6', async () => {
    // ⚠⚠ The shipped blind spot: `family: 4` plus a split on the last colon turned
    // `[::1]:port` into a host of `[::1]`, which net.connect refused — and a refusal PASSES.
    // Every IPv6 target in LURKER_PREVIEWS_SELFTEST_TARGETS was silently a no-op.
    const srv = await listening('::1');
    try {
      expect(srv.target).toMatch(/^\[::1\]:\d+$/);
      expect(await probeConnects(srv.target)).toBe(true);
    } finally {
      await srv.close();
    }
    expect(await probeConnects(srv.target)).toBe(false);
  });

  it('treats a malformed target as unreachable rather than crashing the boot', async () => {
    expect(await probeConnects('not-a-target')).toBe(false);
    expect(await probeConnects('127.0.0.1:notaport')).toBe(false);
    expect(await probeConnects('fd00::1:80')).toBe(false); // unbracketed v6 is ambiguous
  });
});

describe('parseTarget', () => {
  it('reads both families and refuses the rest', () => {
    expect(parseTarget('10.0.0.5:8015')).toEqual({ host: '10.0.0.5', port: 8015 });
    expect(parseTarget('[fd00:ec2::254]:80')).toEqual({ host: 'fd00:ec2::254', port: 80 });
    expect(parseTarget('[fe80::1%eth0]:22')).toEqual({ host: 'fe80::1%eth0', port: 22 });
    expect(parseTarget('host.internal:443')).toEqual({ host: 'host.internal', port: 443 });
    for (const bad of ['', ':80', 'fd00::1:80', '[fd00::1]', '10.0.0.1:0', '10.0.0.1:70000', 'x']) {
      expect(parseTarget(bad)).toBeNull();
    }
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
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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
  it('always includes the cloud metadata service, on both families', () => {
    const targets = probeTargets({} as NodeJS.ProcessEnv);
    expect(targets).toContain('169.254.169.254:80');
    expect(targets).toContain('[fd00:ec2::254]:80');
  });

  it('adds operator-supplied known-listening targets from the env', () => {
    // ⚠ These are the strong probes: a default nothing listens at passes whether the firewall
    // exists or not, so hosted deployments name the cell's own VPC address here.
    const targets = probeTargets({
      LURKER_PREVIEWS_SELFTEST_TARGETS: '10.0.0.5:8015, 10.0.0.1:22, [fd00:1::5]:8015',
    } as NodeJS.ProcessEnv);
    expect(targets).toContain('10.0.0.5:8015');
    expect(targets).toContain('10.0.0.1:22');
    expect(targets).toContain('[fd00:1::5]:8015');
  });
});

describe('gatewayTargetsFrom', () => {
  // Real tables, copied from a Docker container.
  const ROUTE_V4 =
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n' +
    'eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n' +
    'eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n';
  const ROUTE_V6_LINK_LOCAL =
    '00000000000000000000000000000000 00 00000000000000000000000000000000 00 ' +
    'fe800000000000000042acfffe110001 00000400 00000001 00000000 00450003 eth0\n' +
    '00000000000000000000000000000001 80 00000000000000000000000000000000 00 ' +
    '00000000000000000000000000000000 00000000 00000003 00000000 80200001 lo\n';
  const ROUTE_V6_GLOBAL =
    '00000000000000000000000000000000 00 00000000000000000000000000000000 00 ' +
    '2001000000000000000000000000ffff 00000400 00000001 00000000 00450003 eth0\n';
  const ROUTE_V6_NONE =
    '00000000000000000000000000000000 00 00000000000000000000000000000000 00 ' +
    '00000000000000000000000000000000 ffffffff 00000001 00000000 00200200 lo\n';

  it('names the IPv4 default gateway on :22 and :80', () => {
    expect(gatewayTargetsFrom(ROUTE_V4, null)).toEqual(['172.17.0.1:22', '172.17.0.1:80']);
  });

  it('names a link-local IPv6 gateway with its interface as the zone', () => {
    // ⚠ Without the zone a link-local address is not dialable and the probe would pass
    // for the wrong reason.
    expect(gatewayTargetsFrom(null, ROUTE_V6_LINK_LOCAL)).toEqual([
      '[fe80::42:acff:fe11:1%eth0]:22',
      '[fe80::42:acff:fe11:1%eth0]:80',
    ]);
  });

  it('names a global IPv6 gateway bare, and both families together', () => {
    expect(gatewayTargetsFrom(ROUTE_V4, ROUTE_V6_GLOBAL)).toEqual([
      '172.17.0.1:22',
      '172.17.0.1:80',
      '[2001::ffff]:22',
      '[2001::ffff]:80',
    ]);
  });

  it('finds nothing in a table with no default route, or no table', () => {
    expect(gatewayTargetsFrom(null, ROUTE_V6_NONE)).toEqual([]);
    expect(gatewayTargetsFrom(null, null)).toEqual([]);
    expect(gatewayTargetsFrom('garbage\n', 'garbage\n')).toEqual([]);
  });
});

describe('superviseContainment', () => {
  it('flips ready off when a target becomes reachable, and back on when it is fixed', async () => {
    // ⚠⚠ The boot-only test proved what was true at boot. Docker rewrites its chains on a
    // daemon restart and a firewall reload takes the INPUT rule with it; the supervisor is
    // what turns that into 503s instead of a decoder quietly serving uncontained.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const state = { ready: false, reason: 'self-test has not run yet\n' };
    const first = await listening();
    await first.close();
    const target = first.target;
    let hole: { close: () => Promise<void> } | null = null;
    const sup = superviseContainment(state, {
      intervalMs: 30,
      targets: () => [target],
      env: {} as NodeJS.ProcessEnv,
    });
    try {
      await sup.first;
      expect(state.ready).toBe(true);
      expect(state.reason).toBe('');

      // Open the hole: something starts listening at the probed address.
      hole = await listenAt(target);
      await vi.waitFor(() => expect(state.ready).toBe(false), { timeout: 3_000, interval: 10 });
      expect(state.reason).toContain(target);

      // Close it: service resumes without a restart.
      await hole.close();
      hole = null;
      await vi.waitFor(() => expect(state.ready).toBe(true), { timeout: 3_000, interval: 10 });
      expect(state.reason).toBe('');
    } finally {
      sup.stop();
      await hole?.close().catch(() => {});
    }
  });
});

/** Listen at exactly `host:port` again — the port was ours a moment ago. */
async function listenAt(target: string): Promise<{ close: () => Promise<void> }> {
  const parsed = parseTarget(target)!;
  const server = http.createServer((_req, res) => res.end());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(parsed.port, parsed.host, resolve);
  });
  return { close: () => new Promise((resolve) => server.close(() => resolve())) };
}
