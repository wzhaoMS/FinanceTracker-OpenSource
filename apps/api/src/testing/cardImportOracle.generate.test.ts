import fs from 'node:fs';
import { it } from 'vitest';

import { generateCardImportOracle, runCardImportSequence, type OracleObservation } from './cardImportOracle.js';

// Records the A9 oracle (routes/cardImportA9.test.ts) when A9_ORACLE_OUT names the file to write; skipped otherwise.
// Run in a checkout of the oracle build with this file and cardImportOracle.ts copied in. A9_ORACLE_ISSUER names the card
// account's issuer (Chase by default; `discover` for the fixture of an issuer the extension doesn't sync). With
// A9_FULL_SEED it writes that one sequence's observations in full instead (requests, bodies, ledgers), to compare two
// builds by hand.
it.runIf(Boolean(process.env.A9_ORACLE_OUT))('records what this build answers to the A9 sequences', async () => {
  const out = process.env.A9_ORACLE_OUT!;
  const steps = Number(process.env.A9_STEPS ?? 8);
  const issuer = process.env.A9_ORACLE_ISSUER ?? 'chase';
  if (process.env.A9_FULL_SEED) {
    const observations: Array<Omit<OracleObservation, 'world'>> = [];
    await runCardImportSequence(Number(process.env.A9_FULL_SEED), steps, ({ world: _world, ...observation }) => {
      observations.push(observation);
    }, undefined, issuer);
    fs.writeFileSync(out, `${JSON.stringify(observations, null, 1)}\n`);
    return;
  }
  const oracle = await generateCardImportOracle({ sequences: Number(process.env.A9_SEQUENCES ?? 40), steps,
    oracle: process.env.A9_ORACLE_NAME ?? 'this build', issuer });
  fs.writeFileSync(out, `${JSON.stringify(oracle)}\n`);
}, 900_000);
