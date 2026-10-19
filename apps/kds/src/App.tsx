import { useState } from 'react';

import { HybridLogicalClock, formatHlc } from '@pos/sync-protocol';
import { Button, tokens } from '@pos/ui';

/**
 * Sprint 0 shell for the kitchen display. Ticket lanes, bump/recall and all-day counts are
 * Phase 1 slice F7. The HLC here will stamp bump events for ordering across stations.
 */
const clock = new HybridLogicalClock('kds-shell');

export function App() {
  const [bumps, setBumps] = useState<string[]>([]);

  return (
    <main
      style={{
        padding: tokens.space.xl,
        background: tokens.color.bg,
        color: tokens.color.text,
        minHeight: '100vh',
        fontFamily: tokens.font.family,
      }}
    >
      <h1 style={{ fontSize: tokens.font.size.lg, margin: 0 }}>KDS — Sprint 0 shell</h1>
      <p style={{ color: tokens.color.textMuted }}>
        Each bump is stamped with a hybrid logical clock timestamp.
      </p>
      <Button onClick={() => setBumps((b) => [...b, formatHlc(clock.tick())])}>Bump ticket</Button>
      <ol style={{ fontFamily: tokens.font.mono, fontSize: tokens.font.size.sm }}>
        {bumps.map((stamp) => (
          <li key={stamp}>{stamp}</li>
        ))}
      </ol>
    </main>
  );
}
