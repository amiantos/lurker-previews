# lurker-previews

Lurker's link-preview decoder: the service that fetches, scrapes, measures and — eventually —
decodes video posters, so that the cell process holding every IRC session, the database handle
and the session secret never parses a byte a stranger chose.

Plan and rationale: `lurker-dev/LINK_PREVIEWS_ISOLATION.md` in the development tree. The SSRF
model it enforces is documented in lurker's `LINK_PREVIEWS.md`; the fetch guard here **is** that
model's code, moved verbatim from the cell along with its tests.

## What it answers

```
GET  /health           200 once the boot self-test has passed; 503 otherwise
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
```

⚠ **502 and 503 are different answers and must stay different.** The cell caches a 502 as a
dead link for an hour; a 503 gets a fifteen-second TTL and a retry. An origin's busy minute
reported as 502 blanks a good link for everyone.

There is no auth: nothing reaches this process except the cell, over a private bridge network,
and a box built on the assumption it will be compromised is the last place to park a secret.
It holds no credentials, no storage, no state beyond in-memory per-host backoff.

## Egress containment

This service fetches from the public internet **and must not be able to reach anything else** —
not RFC1918, not link-local (the cloud metadata service lives there), not the VPC, not the
docker host. An in-process guard (DNS-pinned, re-vetted per redirect hop) enforces that against
malicious _input_; the network rules enforce it against a malicious _process_, which is the
threat this container exists to contain.

- Enforce with **DROP rules, not REJECT** — the self-test below needs the signals to differ.
- Cover **container→host traffic too** (the INPUT chain, not just DOCKER-USER/FORWARD): the
  droplet's own sshd must not be reachable from here.

**At boot the container probes its own containment**: the cloud metadata address, the default
gateway's ssh/http ports, and every target in `LURKER_PREVIEWS_SELFTEST_TARGETS`. If any TCP
connect _completes_, the egress policy is not in force and the service refuses to serve —
`/health` answers 503 and says why — rather than run a hostile-input parser on your LAN with
nothing visibly wrong. Give the self-test at least one internal target you know is listening
(on a hosted cell: the cell's own VPC address, `10.x.x.x:8015`); a probe nothing listens at
passes whether the firewall exists or not.

## Running it

```sh
docker run -d --name lurker-previews --restart unless-stopped \
  --network lurker-previews-net \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 512m --pids-limit 128 \
  -e LURKER_PREVIEWS_SELFTEST_TARGETS=<cell-vpc-ip>:8015 \
  ghcr.io/amiantos/lurker-previews:latest
```

⚠ `--pids-limit` counts **threads**, not processes. node's own pool plus one capped ffmpeg
decode (`-threads 2`, set in poster.ts) fits comfortably in 128; meaningfully lower starves
thread creation with EAGAIN — and the first symptom is silently posterless cards, because a
missing poster is a supported state and nothing logs.

| env                                | meaning                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `PORT`                             | listen port, default `8030`                                                                         |
| `LURKER_PREVIEWS_SELFTEST_TARGETS` | comma-separated `host:port` list of internal addresses that ARE listening and must NOT be reachable |
| `LURKER_PREVIEWS_ALLOW_PRIVATE`    | `1` skips the self-test — local development only, warns loudly                                      |
| `LURKER_PREVIEW_USER_AGENT`        | override the outbound User-Agent                                                                    |
| `USER_AGENT_CONTACT`               | contact URL appended to the default User-Agent                                                      |

## Development

```sh
npm install
npm test          # the moved cell suites plus this service's own — all offline
npm run check     # typecheck + lint + format
LURKER_PREVIEWS_ALLOW_PRIVATE=1 npm start
```

The tests that matter most are the ones that moved with the guard: `linkFetch.test.ts` dials
its origin first so a warm pooled socket is sitting there when it asserts the refusal — that
test is the only thing pinning the DNS-rebinding defence. Treat every ⚠ comment in this repo
as load-bearing; each one names the shipped bug that earned it.
