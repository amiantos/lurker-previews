# lurker-previews

Lurker's link-preview decoder: the service that fetches, scrapes, measures and decodes video
posters, so that the cell process holding every IRC session, the database handle and the
session secret never parses a byte a stranger chose.

Plan and rationale: `lurker-dev/LINK_PREVIEWS_ISOLATION.md` in the development tree. The SSRF
model it enforces is documented in lurker's `LINK_PREVIEWS.md`; the fetch guard here **is** that
model's code, moved verbatim from the cell along with its tests.

## What it answers

```
GET  /health           200 while the egress self-test passes; 503 otherwise
POST /resolve          { "url": "…" }
  → 200  { kind, title, description, siteName, author, imageUrl,
           imageWidth, imageHeight, embedUrl, mime }     # clamped, vetted metadata
  → 204  fetched fine, nothing worth a card
  → 403  { reason }    refused — the guard would not touch the URL
  → 502  the origin gave nothing usable
  → 503  + Retry-After: origin asked us to back off, or this instance is saturated
POST /fetch            { "url": "…", "range": "bytes=…"? }
  → 200/206  image bytes, streamed, with the origin's Content-Type/Length/Range headers
  → 403/404/413/416/502/503 per the same contract
POST /avatar           { "url": "…" }
  → 200  the image as a square WebP, at most 256 px a side, never enlarged; animated GIF and
         WebP stay animated (x-lurker-avatar-animated: 1) unless they have over 500 frames,
         decode past 20 MP or the result passes 512 KB, when they're their first frame; the
         origin's Cache-Control is forwarded
  → 403 refused · 413 over 8 MB · 415 not an image we take, or a still past 25 MP
  → 502 the origin gave nothing usable · 503 + Retry-After
```

⚠ **`/avatar` never answers 404.** The cell reads a 404 there as "this decoder predates the
endpoint" and relays through `/fetch` instead, so a cell updated before its decoder still
shows avatars.

⚠ **502 and 503 are different answers and must stay different.** The cell caches a 502 as a
dead link for an hour; a 503 gets a fifteen-second TTL and a retry. An origin's busy minute
reported as 502 blanks a good link for everyone.

Every text field the cell receives is vetted (`server/utils/vetText.ts`): control characters
— including the mIRC formatting bytes Lurker's renderer parses — and Unicode format
characters other than ZWJ/ZWNJ and the bidi marks are stripped, and the result is NFC.

There is no auth: nothing reaches this process except the cell, over a private bridge network,
and a box built on the assumption it will be compromised is the last place to park a secret.
It holds no credentials, no storage, no state beyond in-memory per-host backoff. That is only
true while the bridge holds only the cell: if anything else ever joins `lurker-previews-net`,
add a DOCKER-USER rule that admits traffic to `:8030` from the cell's address alone.

Decoders that the service has no use for do not exist at runtime: `server/utils/sharp.ts`
blocks libvips' SVG, TIFF and document loaders at startup, so a mis-labelled SVG never
reaches librsvg however it was served.

## Egress containment

This service fetches from the public internet **and must not be able to reach anything else** —
not RFC1918, not link-local (the cloud metadata service lives there), not the VPC, not the
docker host, on either address family. An in-process guard (DNS-pinned, re-vetted per redirect
hop) enforces that against malicious _input_; the network rules enforce it against a malicious
_process_, which is the threat this container exists to contain.

- Enforce with **DROP rules, not REJECT** — the self-test below needs the signals to differ.
- Cover **container→host traffic too** (the INPUT chain, not just DOCKER-USER/FORWARD): the
  droplet's own sshd must not be reachable from here.
- Cover **IPv6** with ip6tables wherever the container has an IPv6 address; the in-process
  guard allows all of global unicast (`2000::/3`), which on AWS and GCP includes the VPC's own
  subnets, so the firewall is the only thing standing between the decoder and a VPC neighbour.

**The container probes its own containment at boot and every ten minutes after**: the cloud
metadata address on both families (`169.254.169.254`, `fd00:ec2::254`), the default gateways'
ssh/http ports from `/proc/net/route` and `/proc/net/ipv6_route`, and every target in
`LURKER_PREVIEWS_SELFTEST_TARGETS`. If any TCP connect _completes_, the egress policy is not
in force and the service refuses to serve — `/health` answers 503 and says why, the cell
treats it as transient — rather than run a hostile-input parser on your LAN with nothing
visibly wrong. When the rules are back the next probe puts it back in service, no restart.

Give the self-test at least one internal target you know is listening; a probe nothing listens
at passes whether the firewall exists or not. On a hosted cell that is the cell's own VPC
address and its bridge address, `10.x.x.x:8015,172.x.x.x:8015`, plus the host's public IP on
`:22`. IPv6 targets are written in brackets, `[fd00:1::5]:8015`.

## Running it

```sh
docker run -d --name lurker-previews --restart unless-stopped \
  --network lurker-previews-net \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --cap-drop ALL --security-opt no-new-privileges --ipc none \
  --memory 512m --memory-swap 512m --cpus 2 --pids-limit 128 \
  -e LURKER_PREVIEWS_SELFTEST_TARGETS=<cell-vpc-ip>:8015 \
  ghcr.io/amiantos/lurker-previews:latest
```

`/tmp` is where poster bytes land: `noexec,nosuid` so the only writable path cannot stage a
binary, `size=` so a filled tmpfs is a failed poster rather than the host's RAM.
`--memory-swap` equal to `--memory` keeps the limit a limit. Never publish the port (`-p`);
the bridge is the only intended caller.

⚠ `--pids-limit` counts **threads**, not processes. Every ffmpeg and ffprobe this service
spawns is single-threaded by argument (decoder, filter graph and encoder are capped
separately — `-threads` alone capped only the first, and a "two-thread" decode measured fifty
threads on a 16-core host), and at most two run at once, so node's own pool plus the decodes
sit well inside 128. Meaningfully lower starves thread creation with EAGAIN — and the first
symptom is silently posterless cards, because a missing poster is a supported state and
nothing logs.

| env                                       | meaning                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PORT`                                    | listen port, default `8030`                                                                                       |
| `LURKER_PREVIEWS_SELFTEST_TARGETS`        | comma-separated `host:port` / `[v6]:port` list of internal addresses that ARE listening and must NOT be reachable |
| `LURKER_PREVIEWS_SELFTEST_INTERVAL_MS`    | how often the probes repeat, default ten minutes                                                                  |
| `LURKER_PREVIEWS_ALLOW_PRIVATE`           | `1` skips the self-test — local development only, warns loudly                                                    |
| `LURKER_PREVIEWS_POSTER_TIMEOUT_MS`       | wall clock for one ffmpeg/ffprobe run, default `5000`                                                             |
| `LURKER_PREVIEWS_POSTER_FULL_FETCH_BYTES` | ceiling on a whole-file poster fetch, default 64 MiB                                                              |
| `LURKER_PREVIEW_USER_AGENT`               | override the outbound User-Agent                                                                                  |
| `USER_AGENT_CONTACT`                      | contact URL appended to the default User-Agent                                                                    |

Numeric knobs are validated at boot: a value that does not parse as an integer is logged and
the default used, never `NaN` (which once turned the fetch ceiling off silently).

## Development

```sh
npm install
npm test          # the moved cell suites plus this service's own — all offline
npm run check     # typecheck + lint + format
LURKER_PREVIEWS_ALLOW_PRIVATE=1 npm start
```

The poster tests need ffmpeg and skip without it; `docker build --target test .` runs the
whole suite in the image's own environment, which is the gate the published image passes. The
test stage also fails on any high-severity advisory against a runtime dependency, and
Dependabot opens weekly PRs for npm, the base image digest and the workflow actions.

The tests that matter most are the ones that moved with the guard: `linkFetch.test.ts` dials
its origin first so a warm pooled socket is sitting there when it asserts the refusal — that
test is the only thing pinning the DNS-rebinding defence. Treat every ⚠ comment in this repo
as load-bearing; each one names the shipped bug that earned it.
