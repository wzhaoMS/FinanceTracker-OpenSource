/**
 * The acceptance suite's synthetic Holdr (macOS only), run as its own process
 * with tsx: E2c's real app, repository, locks and device admission on a dist
 * Unix socket (apps/api's `cardSyncDeviceWorld`: synthetic data only, its own
 * temporary directories), Holdr's clock set to real time, the Chase-like
 * source enabled and bound to the fake issuer's two cards, and a TLS stand-in
 * for Tailscale Serve in front of the socket.
 *
 * It prints one JSON line when ready (`{ready, port, spki, bindingId}`), then
 * answers JSON-line commands on stdin (`{id, op, ...}` → `{id, ok, ...}`):
 * what the owner does in Holdr (create a pairing code, approve the browser,
 * commit a set) and what the tests read back (runs, devices, requests). It
 * removes everything it created when it closes; nothing else is touched.
 */
import { createInterface } from 'node:readline';
import { pairingCodeDigest, randomCardSyncLetters } from '../../../api/src/services/cardSyncDigests.js';
import { cardSyncDeviceWorld } from '../../../api/src/testing/cardSyncDeviceWorld.js';
import { SCENARIO_OWNER } from '../../../api/src/testing/cardSyncScenario.js';
import { selfSignedIdentity } from './selfSigned.js';
import { startServeStandIn } from './serve.js';

const HOST = 'holdr.test';
const OWNER = { kind: 'session' as const, actorRef: SCENARIO_OWNER };
const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const log = (line: string) => process.stderr.write(`[acceptance target] ${line}\n`);

async function main(): Promise<void> {
  const f = await cardSyncDeviceWorld();
  let ticker: ReturnType<typeof setInterval> | null = null;
  let serve: Awaited<ReturnType<typeof startServeStandIn>> | null = null;
  const close = async () => {
    if (ticker) clearInterval(ticker);
    await serve?.close();
    await f.close();
  };
  try {
    // Holdr's clock is real time: the extension judges pairing, run and plan expiry by its own clock.
    f.w.clock = Date.now();
    ticker = setInterval(() => {
      f.w.clock = Date.now();
    }, 20);
    f.w.enable('chase');
    const binding = f.w.binding({
      source: 'chase-api',
      scopes: [
        { label: 'Primary card', holderAlias: 'alex', last4: '3391' },
        { label: 'Authorized user', holderAlias: 'member-a', last4: '7720' },
      ],
    });
    await f.syncFence();
    const identity = selfSignedIdentity(HOST);
    serve = await startServeStandIn({ identity, publicHost: HOST, upstream: { socketPath: f.config.socketPath } });
    out({ ready: true, port: serve.port, spki: identity.spkiSha256, bindingId: binding.bindingId });

    const db = f.w.db;
    const handle = async (command: { op: string; runId?: string }): Promise<Record<string, unknown>> => {
      switch (command.op) {
        case 'createPairing': {
          const code = randomCardSyncLetters();
          f.repo.createCardSyncPairing({
            actorRef: SCENARIO_OWNER, codeDigest: pairingCodeDigest(code), bindingIds: [binding.bindingId], replacesDeviceId: null, ...f.w.step(),
          });
          await f.syncFence();
          return { code };
        }
        case 'approvePending': {
          const redeemed = f.repo.listCardSyncPairings().filter((pairing) => pairing.status === 'redeemed' && pairing.deviceId && pairing.fingerprint);
          for (const pairing of redeemed) {
            f.repo.approveCardSyncPairing({
              pairingId: pairing.pairingId, deviceId: pairing.deviceId!, fingerprint: pairing.fingerprint!, actorRef: SCENARIO_OWNER, ...f.w.step(),
            });
          }
          await f.syncFence();
          return { approved: redeemed.length };
        }
        case 'devices':
          return {
            devices: f.repo.listCardSyncDevices().map((device) => ({ deviceId: device.deviceId, label: device.label, clientVersion: device.clientVersion, status: device.status })),
          };
        case 'runs': {
          const ids = db.prepare('SELECT id FROM card_sync_runs ORDER BY created_at, rowid').pluck().all() as string[];
          return {
            runs: ids.map((id) => {
              const run = f.repo.getCardSyncRun(id)!;
              return {
                runId: run.runId, trigger: run.trigger, runState: run.runState, abortReason: run.abortReason, errorCode: run.errorCode,
                payloadDigest: run.payloadDigest, observationSetId: run.observationSetId, setState: run.setState,
              };
            }),
          };
        }
        case 'ownerCommit': {
          // The owner reviews the set in Holdr and commits it (E8-M), as a device cannot under contract 1.
          const run = f.repo.getCardSyncRun(String(command.runId))!;
          const set = db.prepare('SELECT version FROM card_sync_observation_sets WHERE id = ?').get(run.observationSetId) as { version: number };
          const plan = f.repo.prepareCardSyncPlan({ principal: OWNER, setId: run.observationSetId!, expectedVersion: set.version, expectedGeneration: f.w.generation() });
          if (plan.status !== 'executable') return { status: plan.status };
          const committed = f.repo.commitCardSyncPlan({
            principal: OWNER, previewId: plan.previewId, payloadDigest: plan.payloadDigest, planDigest: plan.planDigest, expectedGeneration: f.w.generation(),
          });
          return { status: committed.status, counts: committed.counts };
        }
        case 'requests':
          return { requests: serve!.requests };
        case 'close':
          return {};
        default:
          throw new Error(`unknown op ${command.op}`);
      }
    };

    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
      let command: { id: number; op: string; runId?: string };
      try {
        command = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        out({ id: command.id, ok: true, ...(await handle(command)) });
      } catch (error) {
        out({ id: command.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      if (command.op === 'close') break;
    }
  } catch (error) {
    log(`failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    for (const line of f.logs) log(line);
    await close();
  }
}

if (process.platform !== 'darwin') {
  log('the device world needs macOS (E0-I lifecycle locks)');
  process.exit(2);
}
void main().then(() => process.exit(process.exitCode ?? 0));
