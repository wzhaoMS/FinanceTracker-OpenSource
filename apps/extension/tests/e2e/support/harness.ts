/**
 * Playwright fixtures for the extension e2e (plan §9.2):
 * - `world` (per worker): a private run directory under
 *   `<repo>/.artifacts/card-sync-e2e/<run-id>/` (self-ignoring), the fake
 *   issuers and the fake Holdr on loopback (free ports), and the egress gate,
 *   probed before anything runs. Ledgers are written to `logs/` at the end.
 * - `ext` (per test): Playwright's bundled Chromium with a fresh disposable
 *   profile in the run directory, the built test extension loaded unpacked,
 *   every request through the gate, DNS disabled except loopback and WebRTC
 *   forced through the proxy (support/browser.ts). The profile is removed
 *   after the test unless E3_E2E_KEEP=1. Only processes and directories this
 *   run created are touched.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test as base } from '@playwright/test';
import { FakeHoldr } from '../fake/holdr.js';
import { FakeIssuers } from '../fake/issuers.js';
import { openExtension, runDirectory as runDirectoryUnder, type ExtensionSession } from './browser.js';
import { EgressGate } from './gate.js';

const here = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_ROOT = resolve(here, '..', '..', '..');
export const REPO_ROOT = resolve(EXTENSION_ROOT, '..', '..');
export const EXTENSION_PATH = join(EXTENSION_ROOT, 'dist', 'test');
export const EXTENSION_ID = 'icilknejhlhobkgcejnkbhbebnkfldmc';

export const ORIGINS = Object.freeze({
  chase: 'http://chase.e3.test',
  amex: 'http://amex.e3.test',
  citi: 'http://citi.e3.test',
  wf: 'http://wf.e3.test',
  holdr: 'http://holdr.e3.test',
});

/** The run directory: one per `playwright test` invocation, shared by its workers. */
export function runDirectory(): string {
  return runDirectoryUnder(REPO_ROOT);
}

export interface World {
  readonly runDir: string;
  readonly gate: EgressGate;
  readonly issuers: FakeIssuers;
  readonly holdr: FakeHoldr;
}

export interface Ext extends Omit<ExtensionSession, 'close'> {
  pair(label?: string): Promise<void>;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'test';
}

let profileCounter = 0;

export const test = base.extend<{ ext: Ext }, { world: World }>({
  world: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const runDir = runDirectory();
      const issuers = await FakeIssuers.start();
      const holdr = await FakeHoldr.start();
      const routes = new Map<string, number>([...issuers.ports.entries(), ['holdr.e3.test', holdr.port]]);
      const gate = await EgressGate.start(routes);
      await gate.probe();
      try {
        await use({ runDir, gate, issuers, holdr });
      } finally {
        writeFileSync(join(runDir, 'logs', 'gate-ledger.json'), JSON.stringify(gate.ledger, null, 1));
        writeFileSync(join(runDir, 'logs', 'issuer-requests.json'), JSON.stringify(issuers.requests, null, 1));
        writeFileSync(join(runDir, 'logs', 'holdr-requests.json'), JSON.stringify(holdr.requests.map((request) => ({ ...request, body: `${request.body.length} bytes` })), null, 1));
        await gate.close();
        await issuers.close();
        await holdr.close();
      }
    },
    { scope: 'worker' },
  ],
  ext: async ({ world }, use, testInfo) => {
    world.issuers.reset();
    world.holdr.reset();
    profileCounter += 1;
    const profileDir = join(world.runDir, 'p', String(profileCounter));
    const session = await openExtension({ path: EXTENSION_PATH, id: EXTENSION_ID, proxyPort: world.gate.port, profileDir });
    const ext: Ext = {
      ...session,
      async pair(label = 'E3 Test Chromium') {
        const code = world.holdr.createPairing();
        const options = await session.options();
        await options.getByTestId('pairing-code').fill(code.replace(/(.{4})(?=.)/g, '$1-'));
        await options.getByTestId('device-label').fill(label);
        await options.getByTestId('pair').click();
        try {
          await expect(options.getByTestId('fingerprint')).toBeVisible();
        } catch (error) {
          const redeems = world.holdr.requests.filter((request) => request.path === '/card-sync/pairings/redeem').map((request) => request.status);
          throw new Error(`pairing did not complete; redeem answers ${JSON.stringify(redeems)}; page: ${(await options.locator('body').innerText()).slice(0, 600)}`, { cause: error });
        }
        world.holdr.approveAll();
        await options.getByTestId('check-approval').click();
        await expect(options.getByTestId('pairing-status')).toContainText('Paired as');
        await options.close();
      },
    };
    try {
      await use(ext);
    } finally {
      writeFileSync(join(world.runDir, 'logs', `${testInfo.workerIndex}-${slug(testInfo.title)}.console.txt`), session.consoleLines.join('\n'));
      await session.close();
      if (process.env.E3_E2E_KEEP !== '1') rmSync(profileDir, { recursive: true, force: true });
    }
  },
});

export { expect };