// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The boot self-test: prove our own containment before serving anything.
//
// ⚠⚠ LOAD-BEARING, NOT A NICETY. This process runs memory-unsafe parsers (libvips,
// and later ffmpeg) on bytes strangers chose, and its whole security argument is
// that the network around it denies egress to anywhere private — RFC1918,
// link-local, the VPC, the host. That is firewall configuration a self-hoster
// will get wrong, or lose silently on a rebuild, and the failure is INVISIBLE
// because everything keeps working. So the container proves the property at boot
// and refuses to serve when it does not hold, rather than starting in a state
// whose security story is false.
//
// A probe target counts as a FAILURE only when a TCP connect to it COMPLETES.
// Timeouts and refusals both pass: under the DROP rules the deployment ships, a
// blocked target times out, and a refusal only proves something answered with a
// RST — which is why the shipped rules must be DROP, not REJECT, for the signal
// to stay unambiguous.
//
// ⚠ The defaults are only as strong as what happens to be LISTENING at them, so
// deployments add targets they know listen: on a hosted cell,
// `LURKER_PREVIEWS_SELFTEST_TARGETS=<cell VPC ip>:8015` names the exact surface
// we most want unreachable, and it is guaranteed to answer. A random private
// address with nothing on port 80 passes whether the firewall exists or not.
//
// ⚠ This catches the ACCIDENT, not the decision: an operator can run anything
// however they like. `LURKER_PREVIEWS_ALLOW_PRIVATE=1` skips it for local
// development, loudly.

import net from 'node:net';
import { readFileSync } from 'node:fs';

const PROBE_TIMEOUT_MS = 1_500;

/** The cloud metadata service — the classic SSRF pivot, and it LISTENS on real clouds. */
const METADATA_TARGET = '169.254.169.254:80';

/**
 * The container's default gateway — the docker host, read from /proc/net/route
 * (absent and silently skipped anywhere but Linux, i.e. in local dev).
 *
 * ⚠ Reaching the HOST is a containment failure too, and one docker's usual rules
 * don't cover: DOCKER-USER filters FORWARD (container→world), but container→host
 * traffic arrives on the INPUT chain — so a deployment that only added the
 * forward rules leaves the droplet's own sshd reachable from the box that parses
 * hostile bytes. Port 22 is probed precisely because on a droplet it is
 * guaranteed to be listening: a probe nothing listens at proves nothing.
 */
function gatewayTargets(): string[] {
  try {
    const route = readFileSync('/proc/net/route', 'utf8');
    for (const line of route.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      // Destination 00000000 is the default route; gateway is little-endian hex.
      if (cols.length < 3 || cols[1] !== '00000000') continue;
      const hex = cols[2];
      const octets = [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16));
      if (octets.some((o) => Number.isNaN(o))) continue;
      const gw = octets.join('.');
      return [`${gw}:22`, `${gw}:80`];
    }
  } catch {
    // Not Linux, or an unreadable route table: no gateway to probe.
  }
  return [];
}

export function probeTargets(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.LURKER_PREVIEWS_SELFTEST_TARGETS || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return [METADATA_TARGET, ...gatewayTargets(), ...extra];
}

/** One probe. `true` means the connect COMPLETED — the network let us in. */
export function probeConnects(target: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const at = target.lastIndexOf(':');
    const host = target.slice(0, at);
    const port = Number(target.slice(at + 1));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return resolve(false);
    const sock = net.connect({ host, port, family: 4 });
    sock.setTimeout(timeoutMs);
    const done = (connected: boolean): void => {
      sock.destroy();
      resolve(connected);
    };
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

export interface SelfTestResult {
  passed: boolean;
  /** Targets a connect completed to — each one a hole in the egress policy. */
  reachable: string[];
  skipped: boolean;
}

export async function runSelfTest(
  targets: string[] = probeTargets(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<SelfTestResult> {
  if (env.LURKER_PREVIEWS_ALLOW_PRIVATE === '1') {
    console.warn(
      '[previews] ⚠ LURKER_PREVIEWS_ALLOW_PRIVATE=1 — the egress self-test is SKIPPED. ' +
        'This process parses hostile bytes; never run production this way.',
    );
    return { passed: true, reachable: [], skipped: true };
  }
  const results = await Promise.all(targets.map((t) => probeConnects(t)));
  const reachable = targets.filter((_, i) => results[i]);
  return { passed: reachable.length === 0, reachable, skipped: false };
}
