// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  videoEmbedFor,
  oembedEndpointFor,
  EMBED_ORIGINS,
  isEmbeddableOrigin,
} from './linkEmbed.js';

const embed = (raw: string) => videoEmbedFor(new URL(raw));

describe('videoEmbedFor — YouTube', () => {
  it('recognises every shape people actually paste', () => {
    for (const raw of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?v=dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
    ]) {
      expect(embed(raw)?.embedUrl).toContain('dQw4w9WgXcQ');
    }
  });

  it('always uses the no-cookie host', () => {
    const e = embed('https://www.youtube.com/watch?v=abc123');
    expect(e?.embedUrl.startsWith('https://www.youtube-nocookie.com/embed/')).toBe(true);
    expect(e?.provider).toBe('YouTube');
  });

  it('carries a start time through', () => {
    expect(embed('https://youtu.be/abc123?t=90')?.embedUrl).toContain('start=90');
    expect(embed('https://www.youtube.com/watch?v=abc123&start=42')?.embedUrl).toContain(
      'start=42',
    );
  });

  it("understands YouTube's own 1h2m3s timestamp syntax", () => {
    // ⚠⚠ Regression guard. `Number.parseInt` PREFIX-parses, so `?t=1m30s` — the form YouTube's
    // share dialog emits for any timestamp past a minute — silently became `start=1`. A link
    // shared at 1:30 started the player one second in, with no signal, which is strictly worse
    // than the `?t=notanumber` case below where the guard correctly emits nothing.
    const start = (u: string) => new URL(embed(u)!.embedUrl).searchParams.get('start');
    expect(start('https://youtu.be/abc123?t=1m30s')).toBe('90');
    expect(start('https://youtu.be/abc123?t=1h2m3s')).toBe('3723');
    expect(start('https://youtu.be/abc123?t=45s')).toBe('45');
    expect(start('https://youtu.be/abc123?t=2h')).toBe('7200');
  });

  it('ignores a nonsense start time rather than passing it on', () => {
    expect(embed('https://youtu.be/abc123?t=notanumber')?.embedUrl).not.toContain('start=');
    expect(embed('https://youtu.be/abc123?t=-5')?.embedUrl).not.toContain('start=');
    // ⚠ `1e3` prefix-parsed to 1, and a huge value passed `Number.isFinite` and `> 0` while
    // `String(1e21)` is '1e+21' — so `start=1e%2B21` went to a third-party origin immediately
    // after the module had validated the video id against SAFE_ID.
    expect(embed('https://youtu.be/abc123?t=1e3')?.embedUrl).not.toContain('start=');
    expect(embed('https://youtu.be/abc123?t=999999999999999999999')?.embedUrl).not.toContain(
      'start=',
    );
    // Beyond a day is a parse mistake, not a timestamp.
    expect(embed('https://youtu.be/abc123?t=90000')?.embedUrl).not.toContain('start=');
  });

  it('does not advertise a fragment form that cannot reach it', () => {
    // ⚠ `normalizeUrl` strips the fragment upstream (deliberately, so #a and #b share a cache
    // entry), so `searchParams` never sees one. The comment here used to claim `youtu.be#t=`
    // was supported — a class-I defect: a comment asserting a behaviour is a testable
    // assertion, and that one was false.
    expect(embed('https://youtu.be/dQw4w9WgXcQ#t=90')?.embedUrl).not.toContain('start=');
  });

  it('suppresses end-screen recommendations from other channels', () => {
    expect(embed('https://youtu.be/abc123')?.embedUrl).toContain('rel=0');
  });

  it('refuses an id that is not id-shaped', () => {
    // The id lands in a URL we construct, so anything with structure in it is
    // either a parse mistake or someone probing.
    expect(embed('https://www.youtube.com/watch?v=../../evil')).toBeNull();
    expect(embed('https://www.youtube.com/watch?v=a%2Fb')).toBeNull();
    expect(embed('https://www.youtube.com/watch?v=')).toBeNull();
  });

  it('is not fooled by a lookalike hostname', () => {
    expect(embed('https://youtube.com.evil.test/watch?v=abc123')).toBeNull();
    expect(embed('https://notyoutube.com/watch?v=abc123')).toBeNull();
  });
});

describe('videoEmbedFor — Vimeo', () => {
  it('recognises the usual forms', () => {
    expect(embed('https://vimeo.com/123456789')?.embedUrl).toContain('123456789');
    expect(embed('https://player.vimeo.com/video/123456789')?.embedUrl).toContain('123456789');
  });

  it('asks Vimeo not to track', () => {
    expect(embed('https://vimeo.com/123456789')?.embedUrl).toContain('dnt=1');
  });

  it('does not take digits out of an arbitrary path segment', () => {
    // ⚠⚠ Regression guard. The pattern was unanchored where YouTube's is anchored, so an
    // ordinary Vimeo page became an embed of an unrelated video — `/blog/post/10-tips` yielded
    // id `10` and rendered video #10's title, author and thumbnail with a ▶ over it. A wrong
    // answer presented as a right one, cached under the blog post's key.
    expect(embed('https://vimeo.com/blog/post/10-tips-for-video')).toBeNull();
    expect(embed('https://vimeo.com/album/12345/video/67890')).toBeNull();
    expect(embed('https://vimeo.com/channels/staffpicks/page/2')).toBeNull();
    expect(embed('https://vimeo.com/user12345')).toBeNull();
  });

  it('carries the privacy hash of an unlisted video, in either form', () => {
    // ⚠ Without `h`, the player refuses the video — so the facade's ▶ opened a broken frame,
    // which is worse than showing no button at all.
    expect(embed('https://vimeo.com/123456789?h=deadbeef')?.embedUrl).toContain('h=deadbeef');
    expect(embed('https://vimeo.com/123456789/deadbeef')?.embedUrl).toContain('h=deadbeef');
    expect(oembedEndpointFor(new URL('https://vimeo.com/123456789/deadbeef'))).toContain(
      encodeURIComponent('https://vimeo.com/123456789/deadbeef'),
    );
  });

  it('is not fooled by a lookalike hostname', () => {
    expect(embed('https://vimeo.com.evil.test/123456789')).toBeNull();
  });
});

describe('videoEmbedFor — everything else', () => {
  it('returns null, which is an ordinary outcome', () => {
    // A non-video link still gets a normal card; it just has no play button.
    expect(embed('https://example.com/an-article')).toBeNull();
  });
});

describe('EMBED_ORIGINS / isEmbeddableOrigin', () => {
  it('covers every origin the table can actually emit', () => {
    const emitted = [
      embed('https://youtu.be/abc123')!.embedUrl,
      embed('https://vimeo.com/123')!.embedUrl,
    ];
    for (const url of emitted) {
      expect(isEmbeddableOrigin(url)).toBe(true);
      // The exported array is what a client CSP would be generated from, so it has to contain
      // the origin in its own right, not merely satisfy the predicate.
      expect(EMBED_ORIGINS).toContain(new URL(url).origin);
    }
  });

  it('compares origins, not prefixes', () => {
    // ⚠⚠ Regression guard. This test used to assert `url.startsWith(origin)`, which is unsound
    // as an allowlist — and since nothing shipping consumed EMBED_ORIGINS at all, the unsound
    // check lived only here, verifying the constant against its own module.
    expect('https://player.vimeo.com.evil.test/x'.startsWith('https://player.vimeo.com')).toBe(
      true,
    );
    expect(isEmbeddableOrigin('https://player.vimeo.com.evil.test/x')).toBe(false);
    expect(isEmbeddableOrigin('https://www.youtube-nocookie.com.evil.test/embed/x')).toBe(false);
  });

  it('refuses anything that is not one of the two players', () => {
    expect(isEmbeddableOrigin('https://www.youtube.com/embed/abc')).toBe(false);
    expect(isEmbeddableOrigin('http://www.youtube-nocookie.com/embed/abc')).toBe(false); // scheme
    expect(isEmbeddableOrigin('javascript:alert(1)')).toBe(false);
    expect(isEmbeddableOrigin('not a url')).toBe(false);
  });
});

describe('oembedEndpointFor', () => {
  const endpoint = (raw: string) => oembedEndpointFor(new URL(raw));

  it('knows YouTube, from any shape the link was pasted in', () => {
    // ⚠ This is the whole reason the provider table exists. Measured against the real
    // site: 256 KB of youtube.com HTML read, truncated, and `og:title` NOT PRESENT in it
    // — YouTube front-loads a huge inline config blob. The oEmbed endpoint answers the
    // same question in 848 bytes.
    for (const raw of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    ]) {
      expect(endpoint(raw)).toBe(
        'https://www.youtube.com/oembed?url=' +
          encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ') +
          '&format=json',
      );
    }
  });

  it('canonicalises before asking, so one video is one cache entry', () => {
    // youtu.be/X and youtube.com/watch?v=X are the same video; the endpoint must not
    // depend on which one was typed.
    expect(endpoint('https://youtu.be/abc123')).toBe(
      endpoint('https://www.youtube.com/watch?v=abc123'),
    );
  });

  it('knows Vimeo', () => {
    expect(endpoint('https://vimeo.com/123456789')).toBe(
      'https://vimeo.com/api/oembed.json?url=' + encodeURIComponent('https://vimeo.com/123456789'),
    );
  });

  it('returns null for everything else, so the scraper handles it', () => {
    expect(endpoint('https://example.com/an-article')).toBeNull();
    expect(endpoint('https://youtube.com.evil.test/watch?v=abc')).toBeNull();
  });
});
