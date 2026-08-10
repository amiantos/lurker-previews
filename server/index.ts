// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Boot: prove containment, then serve.
//
// The listener starts IMMEDIATELY and the self-test decides what it answers —
// starting the other way round (test, then listen) reads better but makes a
// failed test look like a network problem to the cell, and "the decoder is down"
// and "the decoder refuses to serve" deserve different log lines on both ends.

import { createServer, type ServerState } from './server.js';
import { runSelfTest, probeTargets } from './selfTest.js';
import { APP_VERSION } from './utils/userAgent.js';

const PORT = Number(process.env.PORT ?? 8030);

const state: ServerState = { ready: false, reason: 'self-test has not run yet\n' };
const server = createServer(state);

server.listen(PORT, () => {
  console.log(`[previews] lurker-previews ${APP_VERSION} listening on :${PORT} (not ready)`);
  void (async () => {
    const targets = probeTargets();
    const result = await runSelfTest(targets);
    if (result.passed) {
      state.ready = true;
      state.reason = '';
      const how = result.skipped
        ? 'self-test SKIPPED (LURKER_PREVIEWS_ALLOW_PRIVATE=1)'
        : `egress self-test passed (${targets.length} probes unreachable)`;
      console.log(`[previews] ready — ${how}`);
      return;
    }
    // ⚠⚠ Loud, specific, and terminal for serving: every reachable target is a hole in the
    // egress policy, named so the operator can fix the rule rather than guess. The process
    // stays up so /health has something to say and the container doesn't crash-loop into
    // restart backoff where nobody sees the message.
    state.reason = `egress containment FAILED — reachable from this container: ${result.reachable.join(', ')}\n`;
    console.error(
      `[previews] ⚠⚠ REFUSING TO SERVE. ${state.reason.trim()}. ` +
        'This service runs media parsers on hostile input and must not be able to reach ' +
        'private networks. Fix the network egress rules (DROP, not REJECT) and restart. ' +
        'See lurker-previews README, "Egress containment".',
    );
  })();
});
