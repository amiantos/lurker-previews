// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The self-test: prove our own containment before serving anything, and keep proving it.
//
// ⚠⚠ LOAD-BEARING, NOT A NICETY. This process runs memory-unsafe parsers (libvips,
// ffmpeg) on bytes strangers chose, and its whole security argument is that the
// network around it denies egress to anywhere private — RFC1918, link-local, the
// VPC, the host. That is firewall configuration a self-hoster will get wrong, or
// lose silently on a rebuild, and the failure is INVISIBLE because everything
// keeps working. So the container proves the property and refuses to serve when
// it does not hold, rather than running in a state whose security story is false.
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
// ⚠⚠ Both address families. The first version dialled `family: 4` and split a target
// on its last colon, so a bracketed IPv6 target became the host `[fd00:ec2::254]`,
// which `net.connect` refuses — and a refusal is a PASS. Every IPv6 target silently
// passed, and no default probed IPv6 at all; a host whose ip6tables rules were missing
// looked identical to one whose rules were right.
//
// ⚠⚠ Periodic, not once. Docker rewrites its chains on daemon restart and network
// recreation, a host firewall reload takes the INPUT rule with it, and
// `--restart unless-stopped` brings this container back after a reboot whose
// firewall unit failed. A test that ran at boot proves what was true at boot.
//
// ⚠ This catches the ACCIDENT, not the decision: an operator can run anything
// however they like. `LURKER_PREVIEWS_ALLOW_PRIVATE=1` skips it for local
// development, loudly.

import net from 'node:net';
import { readFileSync } from 'node:fs';

const PROBE_TIMEOUT_MS = 1_500;

/** The cloud metadata service — the classic SSRF pivot, and it LISTENS on real clouds —
 *  at its IPv4 address and at the IPv6 one AWS answers on when the instance has IPv6. */
const METADATA_TARGETS = ['169.254.169.254:80', '[fd00:ec2::254]:80'];

/**
 * The container's default gateways — the docker host — read from /proc/net/route and
 * /proc/net/ipv6_route (absent and silently skipped anywhere but Linux, i.e. in local dev).
 *
 * ⚠ Reaching the HOST is a containment failure too, and one docker's usual rules
 * don't cover: DOCKER-USER filters FORWARD (container→world), but container→host
 * traffic arrives on the INPUT chain — so a deployment that only added the
 * forward rules leaves the droplet's own sshd reachable from the box that parses
 * hostile bytes. Port 22 is probed precisely because on a droplet it is
 * guaranteed to be listening: a probe nothing listens at proves nothing.
 */
function gatewayTargets(): string[] {
  const read = (file: string): string | null => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null; // Not Linux, or an unreadable route table: no gateway to probe.
    }
  };
  return gatewayTargetsFrom(read('/proc/net/route'), read('/proc/net/ipv6_route'));
}

/** The parse, split from the read so it can be fed a route table. */
export function gatewayTargetsFrom(routeV4: string | null, routeV6: string | null): string[] {
  const out: string[] = [];
  const gw4 = routeV4 ? defaultGatewayV4(routeV4) : null;
  if (gw4) out.push(`${gw4}:22`, `${gw4}:80`);
  const gw6 = routeV6 ? defaultGatewayV6(routeV6) : null;
  if (gw6) out.push(`[${gw6}]:22`, `[${gw6}]:80`);
  return out;
}

function defaultGatewayV4(route: string): string | null {
  for (const line of route.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    // Destination 00000000 is the default route; gateway is little-endian hex.
    if (cols.length < 3 || cols[1] !== '00000000') continue;
    const hex = cols[2];
    const octets = [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16));
    if (octets.some((o) => Number.isNaN(o))) continue;
    return octets.join('.');
  }
  return null;
}

/**
 * /proc/net/ipv6_route: `dest prefix src prefix nexthop metric refcnt use flags ifname`,
 * addresses as 32 hex digits. The default route has an all-zero destination with prefix 00
 * and the RTF_GATEWAY flag (0x2). A link-local gateway (the usual kind) is only dialable
 * with its interface as the zone, `fe80::1%eth0`, which node accepts.
 */
function defaultGatewayV6(route: string): string | null {
  const ZERO = '0'.repeat(32);
  for (const line of route.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10 || cols[0] !== ZERO || cols[1] !== '00') continue;
    const flags = parseInt(cols[8], 16);
    if (Number.isNaN(flags) || !(flags & 0x2)) continue;
    const hop = cols[4];
    if (!/^[0-9a-f]{32}$/i.test(hop) || hop === ZERO) continue;
    const groups = Array.from({ length: 8 }, (_, i) =>
      parseInt(hop.slice(i * 4, i * 4 + 4), 16).toString(16),
    );
    const addr = compressV6(groups);
    const linkLocal = (parseInt(groups[0], 16) & 0xffc0) === 0xfe80;
    return linkLocal ? `${addr}%${cols[9]}` : addr;
  }
  return null;
}

export function probeTargets(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.LURKER_PREVIEWS_SELFTEST_TARGETS || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return [...METADATA_TARGETS, ...gatewayTargets(), ...extra];
}

/** `host:port`, or `[v6]:port`. Anything else is not a target. */
export function parseTarget(target: string): { host: string; port: number } | null {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(target) ?? /^([^:\s]+):(\d+)$/.exec(target);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

/** One probe. `true` means the connect COMPLETED — the network let us in. */
export function probeConnects(target: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const parsed = parseTarget(target);
    if (!parsed) return resolve(false);
    // ⚠ No `family`: the literal decides. Forcing 4 is how IPv6 targets came to pass silently.
    const sock = net.connect({ host: parsed.host, port: parsed.port });
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

/** What the server answers from: the readiness latch and the reason it is down. */
export interface Containment {
  ready: boolean;
  reason: string;
}

export interface SuperviseOptions {
  /** Re-probed this often, after the first run. */
  intervalMs: number;
  targets?: () => string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Prove containment now, then keep proving it: every `intervalMs` the probes run again and
 * `state.ready` follows the result, so a firewall that lapses turns into 503s (which the cell
 * treats as transient) within one interval, and one that is fixed turns back into service
 * without a restart.
 *
 * ⚠⚠ Loud, specific, and terminal for serving: every reachable target is a hole in the egress
 * policy, named so the operator can fix the rule rather than guess. The process stays up so
 * /health has something to say and the container doesn't crash-loop into restart backoff
 * where nobody sees the message.
 */
export function superviseContainment(
  state: Containment,
  opts: SuperviseOptions,
): { stop: () => void; first: Promise<void> } {
  const targets = opts.targets ?? probeTargets;
  let running = false;
  const check = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const list = targets();
      const result = await runSelfTest(list, opts.env);
      if (result.passed) {
        if (!state.ready) {
          const how = result.skipped
            ? 'self-test SKIPPED (LURKER_PREVIEWS_ALLOW_PRIVATE=1)'
            : `egress self-test passed (${list.length} probes unreachable)`;
          console.log(`[previews] ready — ${how}`);
        }
        state.ready = true;
        state.reason = '';
        return;
      }
      state.reason = `egress containment FAILED — reachable from this container: ${result.reachable.join(', ')}\n`;
      state.ready = false;
      console.error(
        `[previews] ⚠⚠ REFUSING TO SERVE. ${state.reason.trim()}. ` +
          'This service runs media parsers on hostile input and must not be able to reach ' +
          'private networks. Fix the network egress rules (DROP, not REJECT); the probe ' +
          `repeats every ${Math.round(opts.intervalMs / 1000)}s. ` +
          'See lurker-previews README, "Egress containment".',
      );
    } finally {
      running = false;
    }
  };
  const first = check();
  const timer = setInterval(() => void check(), opts.intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), first };
}

/** The usual `::` for the longest run of zero groups, so a log line reads like an address. */
function compressV6(groups: string[]): string {
  let best = -1;
  let bestLen = 0;
  let start = -1;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] !== '0') {
      start = -1;
      continue;
    }
    if (start === -1) start = i;
    const len = i - start + 1;
    if (len > bestLen) {
      best = start;
      bestLen = len;
    }
  }
  if (bestLen < 2) return groups.join(':');
  return `${groups.slice(0, best).join(':')}::${groups.slice(best + bestLen).join(':')}`;
}
