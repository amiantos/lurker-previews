// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The address guard is the single most security-sensitive thing in the tree: two features hand
// the server an address that someone else chose, and it decides whether to dial it. These tests
// are the record of three separate SSRF holes found in it, each a different IPv6 notation that a
// deny-list didn't know about — which is why it's now an allowlist.

import { describe, it, expect } from 'vitest';
import { isBlockedIpv4, isBlockedIpLiteral } from './ipGuard.js';

describe('isBlockedIpv4', () => {
  it('blocks every internal range', () => {
    for (const ip of [
      '0.0.0.0',
      '10.0.0.1',
      '127.0.0.1',
      '169.254.169.254', // the one that matters most: cloud metadata
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1', // CGNAT
      '224.0.0.1', // multicast
      '255.255.255.255',
    ]) {
      expect(isBlockedIpv4(ip)).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1']) {
      expect(isBlockedIpv4(ip)).toBe(false);
    }
  });

  it('fails safe on anything malformed', () => {
    for (const ip of ['', 'not-an-ip', '1.2.3', '1.2.3.4.5', '999.1.1.1', '1.2.3.-1']) {
      expect(isBlockedIpv4(ip)).toBe(true);
    }
  });
});

describe('isBlockedIpLiteral', () => {
  it('blocks internal IPv6', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12::3', 'ff02::1']) {
      expect(isBlockedIpLiteral(ip)).toBe(true);
    }
  });

  it('judges IPv4-mapped IPv6 by the embedded address', () => {
    expect(isBlockedIpLiteral('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIpLiteral('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedIpLiteral('::ffff:8.8.8.8')).toBe(false);
  });

  it('allows public IPv6', () => {
    expect(isBlockedIpLiteral('2606:4700:4700::1111')).toBe(false);
  });
});

describe('isBlockedIpLiteral — IPv4-embedding IPv6 notations', () => {
  it('blocks an IPv4-mapped address in the HEX form the URL parser produces', () => {
    // ⚠⚠ The regression that matters. `new URL('http://[::ffff:169.254.169.254]/')` rewrites
    // the host to `[::ffff:a9fe:a9fe]`, and an earlier deny-list version matched only the
    // DOTTED form — so this sailed through to the cloud metadata endpoint. `net.isIP` calls it
    // IPv6, so node skips DNS and `pinnedLookup` never runs: this function is the only guard.
    expect(isBlockedIpLiteral('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isBlockedIpLiteral('::ffff:7f00:1')).toBe(true); // 127.0.0.1
    expect(isBlockedIpLiteral('::ffff:a00:5')).toBe(true); // 10.0.0.5
    expect(isBlockedIpLiteral('::ffff:c0a8:1')).toBe(true); // 192.168.0.1
  });

  it('still blocks the dotted mapped form', () => {
    expect(isBlockedIpLiteral('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIpLiteral('::ffff:169.254.169.254')).toBe(true);
  });

  it('allows a mapped PUBLIC address in either notation', () => {
    expect(isBlockedIpLiteral('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedIpLiteral('::ffff:808:808')).toBe(false);
  });

  it('blocks deprecated IPv4-compatible and NAT64 embeddings', () => {
    expect(isBlockedIpLiteral('::127.0.0.1')).toBe(true);
    expect(isBlockedIpLiteral('::a9fe:a9fe')).toBe(true);
    expect(isBlockedIpLiteral('64:ff9b::169.254.169.254')).toBe(true);
  });

  it('handles bracketed input, as `new URL().hostname` hands it over', () => {
    expect(isBlockedIpLiteral('[::ffff:7f00:1]')).toBe(true);
    expect(isBlockedIpLiteral('[2606:4700:4700::1111]')).toBe(false);
  });
});

describe('isBlockedIpLiteral — IPv4-in-IPv6 tunnels', () => {
  it('blocks 6to4, which sits INSIDE the 2000::/3 allowlist', () => {
    // ⚠ The mapped-address hole again in a different notation: 2002::/16 embeds an IPv4 and is
    // global unicast, so the allowlist passed it. `net.isIP` calls it IPv6, so `pinnedLookup`
    // never runs either.
    expect(isBlockedIpLiteral('2002:7f00:0001::')).toBe(true); // 127.0.0.1
    expect(isBlockedIpLiteral('2002:0a00:0001::')).toBe(true); // 10.0.0.1
    expect(isBlockedIpLiteral('2002:a9fe:a9fe::')).toBe(true); // 169.254.169.254
  });

  it('blocks Teredo', () => {
    expect(isBlockedIpLiteral('2001:0:0:0:0:0:a9fe:a9fe')).toBe(true);
    expect(isBlockedIpLiteral('2001:0::1')).toBe(true);
  });

  it('does not over-block ordinary public IPv6 that merely starts 2001', () => {
    expect(isBlockedIpLiteral('2001:db8::1')).toBe(false);
    expect(isBlockedIpLiteral('2001:4860:4860::8888')).toBe(false);
    expect(isBlockedIpLiteral('2606:4700:4700::1111')).toBe(false);
  });

  it('refuses every shape of stray colon', () => {
    // ⚠ Found by review after the two-elision case below. `.filter(g => g !== '')` dropped empty
    // groups instead of rejecting them, so a leading, trailing or tripled colon all parsed as
    // well-formed. Not reachable through a URL today — node's own parser rejects these first —
    // but this guard is also called with DCC-supplied hosts, and "fails closed" has to mean it.
    for (const bad of [':1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8:', ':::1', 'a::b:', '::a:', ':']) {
      expect(isBlockedIpLiteral(bad)).toBe(true);
    }
  });

  it('refuses an elision that elides nothing', () => {
    // ⚠ `::` must stand for AT LEAST one group. The lenient check didn't merely accept
    // `1::2:3:4:5:6:7:8` — it silently REINTERPRETED it as `1:2:3:4:5:6:7:8`, a different
    // address from the one written. A guard that judges a different address than the one that
    // gets dialled is the classic parser-differential hole.
    expect(isBlockedIpLiteral('1::2:3:4:5:6:7:8')).toBe(true);
    expect(isBlockedIpLiteral('2001:0:0:0:0:0:0::1')).toBe(true);
  });

  it('still accepts the valid forms it has to', () => {
    // The counterweight: strictness must not start refusing real addresses.
    expect(isBlockedIpLiteral('2606:4700:4700::1111')).toBe(false); // elided middle
    expect(isBlockedIpLiteral('2001:4860:4860:0:0:0:0:8888')).toBe(false); // fully spelled out
    expect(isBlockedIpLiteral('::ffff:8.8.8.8')).toBe(false); // mapped, dotted
    expect(isBlockedIpLiteral('::ffff:808:808')).toBe(false); // mapped, hex
  });

  it('refuses a literal with two elisions instead of parsing it', () => {
    // `filter(g => g !== '')` swallowed the extra empty groups, so this parsed as valid — the
    // parser failing open in a guard whose whole premise is failing closed.
    expect(isBlockedIpLiteral('2001::1::1')).toBe(true);
    expect(isBlockedIpLiteral('::1::')).toBe(true);
  });
});

describe('isBlockedIpLiteral — IPv6 is an allowlist', () => {
  it('allows only global unicast (2000::/3)', () => {
    expect(isBlockedIpLiteral('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedIpLiteral('2001:db8::1')).toBe(false);
    expect(isBlockedIpLiteral('3fff::1')).toBe(false);
    // Just outside the range on either side.
    expect(isBlockedIpLiteral('1fff::1')).toBe(true);
    expect(isBlockedIpLiteral('4000::1')).toBe(true);
  });

  it('blocks unassigned space rather than allowing what it does not recognise', () => {
    // The point of the allowlist: a deny-list cannot be audited over 128 bits.
    for (const ip of ['0100::1', '5000::1', '8000::1', 'c000::1', 'e000::1']) {
      expect(isBlockedIpLiteral(ip)).toBe(true);
    }
  });

  it('blocks anything it cannot parse', () => {
    for (const bad of [':::1', '::ffff:1.2.3', '12345::1', 'gggg::1', '1:2:3:4:5:6:7', '::1::2']) {
      expect(isBlockedIpLiteral(bad)).toBe(true);
    }
  });
});
