// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Boot: prove containment, then serve — and keep proving it (selfTest.ts).
//
// The listener starts IMMEDIATELY and the self-test decides what it answers —
// starting the other way round (test, then listen) reads better but makes a
// failed test look like a network problem to the cell, and "the decoder is down"
// and "the decoder refuses to serve" deserve different log lines on both ends.

import { createServer, type ServerState } from './server.js';
import { superviseContainment } from './selfTest.js';
import { envInt } from './utils/env.js';
import { APP_VERSION } from './utils/userAgent.js';

const PORT = envInt('PORT', 8030, { min: 1, max: 65535 });
/** How often the egress probes repeat. Ten minutes: a lapsed firewall is a 503 within that. */
const SELFTEST_INTERVAL_MS = envInt('LURKER_PREVIEWS_SELFTEST_INTERVAL_MS', 10 * 60_000, {
  min: 1,
  max: 2 ** 31 - 1, // node clamps a longer timer to 1 ms
});

const state: ServerState = { ready: false, reason: 'self-test has not run yet\n' };
const server = createServer(state);

server.listen(PORT, () => {
  console.log(`[previews] lurker-previews ${APP_VERSION} listening on :${PORT} (not ready)`);
  superviseContainment(state, { intervalMs: SELFTEST_INTERVAL_MS });
});
