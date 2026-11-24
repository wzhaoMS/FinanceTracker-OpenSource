// The receiver's commands: start (the default), pair, check, outbox and help.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigError, resolveConfig, USAGE } from './config.mjs';
import { convertAmexStatements, loadSharedTool } from './convert.mjs';
import { createReceiverCore, PROTOCOL } from './core.mjs';
import { createHoldrApi, describeApiError, nothingLeftToImport } from './holdr-api.mjs';
import { createLogger } from './logger.mjs';
import { listOutbox, sweepOutboxTemp } from './outbox.mjs';
import { ensurePairing, loadState, PairingError, readPairing, saveState } from './pairing.mjs';
import { matchCardAccount, rangesContain } from './plan.mjs';
import { inspectPrivate, makePrivateDir } from './private-fs.mjs';
import { createRawStore, RAW_NAME } from './raw-store.mjs';
import { createChannel, createReceiverServer } from './server.mjs';

const IMPORT_HINT = 'Import it in Holdr: Spending (Card transactions), Import redacted JSON, choose the file, review, Import.';
const AGENT_DIR = fileURLToPath(new URL('..', import.meta.url));

/** A short fingerprint of the receiver's code in this checkout: a running receiver reports its own in /healthz. */
export function codeBuild(agentDir = AGENT_DIR) {
  const hash = createHash('sha256');
  const lib = fs.readdirSync(path.join(agentDir, 'lib')).filter((name) => /\.m[jt]s$/.test(name)).sort();
  for (const name of ['receiver.mjs', ...lib.map((entry) => `lib/${entry}`)]) {
    hash.update(`${name}\0`).update(fs.readFileSync(path.join(agentDir, name))).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

/** How to stop a receiver that is already running. */
function stopHint(platform) {
  if (platform === 'win32') return 'stop it with: powershell -NoProfile -ExecutionPolicy Bypass -File agents\\card-sync\\install\\windows\\stop-receiver.ps1';
  if (platform === 'darwin') return 'stop it with Ctrl+C in its window, or the auto-start one with: launchctl bootout gui/$(id -u)/local.holdr.card-sync';
  return 'stop it with Ctrl+C in its window';
}

/** What to do about an imports folder that is not private (`problem` from inspectPrivate). */
export function privacyAdvice(problem, platform) {
  if (problem === 'symbolic link') return 'use a real folder, not a link (--imports)';
  if (problem === 'access list could not be read') return 'Windows PowerShell could not read its access list; run check again';
  if (platform !== 'win32' && problem === 'owned by another account') return 'use a folder of your own (--imports)';
  return platform === 'win32'
    ? 'start the receiver, or restart it (docs/sync-agent.md, Update), which makes the folder yours and private to you and '
      + 'SYSTEM; if it cannot, use a folder of your own (--imports)'
    : 'run chmod 700 on it, or start the receiver (or restart it, docs/sync-agent.md, Update), which does that';
}

/** Whether this Node.js runs Holdr: 'ok' for 22.3 or a later 22.x release (package.json engines), else 'unsupported'. */
export function nodeSupport(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major === 22 && minor >= 3 ? 'ok' : 'unsupported';
}

function preparePrivateFolders(config) {
  makePrivateDir(config.importsDir, { platform: config.platform });
  makePrivateDir(config.rawDir, { platform: config.platform });
  makePrivateDir(config.outboxDir, { platform: config.platform });
}

/** What is listening on the receiver port: `{ state: 'free' | 'receiver' | 'other', build }` (a receiver's code build). */
function probePort(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 1500, headers: { Host: `127.0.0.1:${port}` } }, (response) => {
      let text = '';
      response.setEncoding('utf8').on('data', (chunk) => { text += chunk; }).on('end', () => {
        try {
          const health = JSON.parse(text);
          resolve(health.service === 'holdr-card-sync'
            ? { state: 'receiver', build: typeof health.build === 'string' ? health.build : null } : { state: 'other', build: null });
        } catch {
          resolve({ state: 'other', build: null });
        }
      });
    });
    request.on('timeout', () => { request.destroy(); resolve({ state: 'other', build: null }); });
    request.on('error', (error) => resolve({ state: error?.code === 'ECONNREFUSED' ? 'free' : 'other', build: null }));
  });
}

async function startCommand(config, io) {
  try {
    preparePrivateFolders(config);
  } catch (error) {
    io.stderr.write(`card-sync: the imports folder could not be made private (${error.message})\n`);
    return 1;
  }
  const logger = createLogger({ file: config.logFile, stream: io.stdout, platform: config.platform });
  let pairing;
  try {
    const ensured = ensurePairing(config.pairingFile, { port: config.port, platform: config.platform });
    pairing = ensured.pairing;
    if (ensured.created) logger.info('created a new pairing key for the extension: reload the extension once (chrome://extensions or edge://extensions)');
    if (ensured.changed) logger.info('the receiver port changed: reload the extension once so that it uses the new port');
  } catch (error) {
    logger.info(`cannot start: ${error instanceof PairingError ? error.message : 'the pairing key could not be prepared'}`);
    logger.close();
    return 1;
  }
  try {
    await loadSharedTool();
  } catch {
    logger.info('cannot start: the card-import tool could not be loaded from packages/shared/src; run npm ci in the repository');
    logger.close();
    return 1;
  }
  const state = loadState(config.statePath, { platform: config.platform });
  const rawStore = createRawStore(config.rawDir);
  const api = createHoldrApi({ appUrl: config.appUrl, tokenFile: config.tokenFile });
  const core = createReceiverCore({
    config, salt: state.identitySalt, api, rawStore, convert: convertAmexStatements, log: logger.event,
    reads: state.reads, saveReads: () => saveState(config.statePath, state, { platform: config.platform }),
  });
  const channel = createChannel({ key: pairing.pairingKey, dispatch: core.dispatch, log: logger.event });
  const receiver = createReceiverServer({
    port: config.port, extensionId: config.extensionId, channel, log: logger.event, protocol: PROTOCOL, build: codeBuild(),
  });
  try {
    await receiver.listen();
  } catch (error) {
    logger.info(error?.code === 'EADDRINUSE'
      ? `cannot start: port ${config.port} on 127.0.0.1 is in use (another receiver, perhaps the auto-start one, may be running); ${stopHint(config.platform)}`
      : 'cannot start: the receiver could not listen on 127.0.0.1');
    logger.close();
    return 1;
  }
  // Only the receiver that holds the port cleans up, so a second copy never deletes a running sync's files.
  const swept = await rawStore.sweep();
  if (swept.removed > 0) logger.event({ kind: 'raw-leftovers-deleted', count: swept.removed });
  if (swept.unknown.length > 0) logger.event({ kind: 'raw-folder-has-other-files', count: swept.unknown.length });
  sweepOutboxTemp(config.outboxDir);
  logger.info(`listening on http://127.0.0.1:${config.port} for the extension ${config.extensionId}`);
  logger.info(`converted files go to ${config.outboxDir}`);
  const holdr = await api.status();
  logger.info(holdr.status === 'ok'
    ? `Holdr at ${config.appUrl} is reachable (schema ${holdr.schemaVersion}): previews are on`
    : `Holdr is not available yet (${holdr.message}); files are still saved, and previews start once it is`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    logger.info('stopping');
    try {
      await core.shutdown();
    } catch {
      logger.info('a raw export could not be deleted while stopping; it is deleted at the next start');
    }
    await receiver.close();
    logger.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return 0;
}

function pairCommand(config, io) {
  try {
    const before = config.rotate ? null : readPairing(config.pairingFile);
    const { created, changed } = ensurePairing(config.pairingFile, { port: config.port, rotate: config.rotate, platform: config.platform });
    if (config.rotate) io.stdout.write('A new pairing key replaced the old one.\n');
    else if (created) io.stdout.write('Created the pairing key.\n');
    else if (changed) io.stdout.write(`Kept the pairing key and set the receiver port to ${config.port}.\n`);
    else if (before) io.stdout.write('The extension is already paired with this receiver; nothing changed.\n');
    io.stdout.write(`Pairing file: ${config.pairingFile} (private; never commit or share it)\n`);
    if (created || changed || config.rotate) {
      io.stdout.write('Now reload the extension once (chrome://extensions or edge://extensions, the reload arrow on "Holdr Card Sync"),\n'
        + 'and restart the receiver if it is running.\n');
    }
    return 0;
  } catch (error) {
    io.stderr.write(`card-sync: ${error instanceof PairingError ? error.message : 'the pairing key could not be written'}\n`);
    return 1;
  }
}

async function checkCommand(config, io) {
  const lines = [];
  let problems = 0;
  const report = (label, ok, text) => {
    if (ok === false) problems += 1;
    lines.push(`  ${ok === false ? 'PROBLEM' : ok === null ? 'note   ' : 'ok     '}  ${label.padEnd(18)}${text}`);
  };
  const node = nodeSupport();
  report('Node.js', node === 'ok', node === 'ok' ? process.version
    : `${process.version}: Holdr needs Node.js 22 (22.3 or later); install it as in docs/getting-started.md, step 1`);
  const port = await probePort(config.port);
  // A receiver still running from before an update keeps the port: the new code would not start.
  const stale = port.state === 'receiver' && port.build !== codeBuild();
  report('Receiver port', port.state === 'other' || stale ? false : port.state === 'receiver' ? null : true,
    port.state === 'free' ? `127.0.0.1:${config.port} is free`
      : stale ? `the receiver running on 127.0.0.1:${config.port} was started from other code (from before an update?): ${stopHint(config.platform)}, then start it again`
        : port.state === 'receiver' ? `a receiver is already running on 127.0.0.1:${config.port}`
          : `127.0.0.1:${config.port} is used by another program: choose --port`);
  const manifest = fs.existsSync(`${config.extensionDir}/manifest.json`);
  report('Extension folder', manifest, manifest ? config.extensionDir : `${config.extensionDir} has no manifest.json (set HOLDR_EXTENSION_DIR)`);
  try {
    const pairing = readPairing(config.pairingFile);
    report('Pairing key', pairing ? true : false, pairing
      ? `present (receiver port ${pairing.receiverPort}${pairing.receiverPort === config.port ? '' : `; the receiver will switch it to ${config.port}`})`
      : 'missing: run the pair command, then reload the extension');
  } catch (error) {
    report('Pairing key', false, error.message);
  }
  report('Extension ID', null, `${config.extensionId} (${config.extensionIdSource === 'manifest' ? 'pinned by the extension manifest' : `from ${config.extensionIdSource}`})`);
  const imports = inspectPrivate(config.importsDir, { platform: config.platform });
  report('Imports folder', imports.ok ? true : imports.problem === 'missing' ? null : false,
    `${config.importsDir}${imports.ok ? ' (private)' : imports.problem === 'missing' ? ' (created privately when the receiver starts)'
      : ` (${imports.problem}): ${privacyAdvice(imports.problem, config.platform)}`}`);
  let leftovers = 0;
  let others = 0;
  try {
    for (const entry of fs.readdirSync(config.rawDir)) {
      if (RAW_NAME.test(entry)) leftovers += 1;
      else others += 1;
    }
  } catch {
    // No raw folder yet.
  }
  report('Raw exports', others === 0 ? (leftovers === 0 ? true : null) : false, others > 0
    ? `${config.rawDir} holds ${others} file(s) the receiver did not write: move them out`
    : leftovers === 0 ? 'none kept' : `${leftovers} left over from an interrupted sync; deleted when the receiver starts`);
  report('Outbox', null, `${listOutbox(config.outboxDir).length} file(s) waiting in ${config.outboxDir}`);
  const tokenThere = fs.existsSync(config.tokenFile);
  report('Service token', tokenThere ? true : false, `${config.tokenFile} (${config.tokenSource})${tokenThere ? ''
    : ' was not found: start Holdr once (it creates the file), or point the receiver at Holdr\'s data folder with --data-dir'}`);
  // With the token: Holdr must accept it, over a connection to a program that runs under this account.
  const api = createHoldrApi({ appUrl: config.appUrl, tokenFile: config.tokenFile });
  let holdr;
  try {
    holdr = { status: 'ok', ...(await api.health()) };
  } catch (error) {
    holdr = describeApiError(error);
  } finally {
    api.close();
  }
  report('Holdr API', holdr.status === 'ok', holdr.status === 'ok'
    ? `${config.appUrl} (schema ${holdr.schemaVersion}; run by your account, accepts the service token)` : `${config.appUrl}: ${holdr.message}`);
  try {
    await loadSharedTool();
    report('Card-import tool', true, 'loads from packages/shared/src');
  } catch {
    report('Card-import tool', false, 'could not be loaded from packages/shared/src: run npm ci');
  }
  io.stdout.write(`Holdr card sync check\n${lines.join('\n')}\n${problems === 0 ? 'Ready.' : `${problems} problem(s) found.`}\n`);
  return problems === 0 ? 0 : 1;
}

async function outboxCommand(config, io) {
  const entries = listOutbox(config.outboxDir);
  if (entries.length === 0) {
    io.stdout.write(`The outbox is empty (${config.outboxDir}).\n`);
    return 0;
  }
  const tool = await loadSharedTool();
  const api = createHoldrApi({ appUrl: config.appUrl, tokenFile: config.tokenFile });
  let accounts = null;
  let coverage = [];
  let holdrProblem = null;
  try {
    accounts = await api.listCardAccounts();
    coverage = await api.coverage();
  } catch (error) {
    holdrProblem = describeApiError(error).message;
  }
  io.stdout.write(`Files waiting in ${config.outboxDir}:\n`);
  let deleted = 0;
  for (const entry of entries) {
    let payload;
    try {
      const checked = tool.validateCardImportPayload(JSON.parse(fs.readFileSync(entry.file, 'utf8')));
      if (!checked.ok) throw new Error('invalid');
      payload = checked.payload;
    } catch {
      io.stdout.write(`  ${entry.name}: not a valid holdr.card-import file; delete it and sync again\n`);
      continue;
    }
    const head = `  ${entry.name}: ${payload.rows.length} ${payload.rows.length === 1 ? 'row' : 'rows'}`;
    if (!accounts) {
      io.stdout.write(`${head}\n`);
      continue;
    }
    const match = matchCardAccount(accounts, entry.last5);
    if (match.status !== 'matched') {
      io.stdout.write(`${head}; ${match.status === 'ambiguous'
        ? 'two Holdr card accounts could be this card: choose the right one in the import dialog'
        : `no Holdr card account for ··${entry.last5} yet: in the import dialog choose a new card account, ending ${entry.last5}`}\n`);
      continue;
    }
    try {
      const preview = await api.preview(match.account.id, fs.readFileSync(entry.file, 'utf8'));
      const ranges = coverage.find((card) => card.cardAccountId === match.account.id)?.ranges ?? [];
      const done = nothingLeftToImport(preview) && rangesContain(ranges, payload.coverage);
      const counts = `${preview.newCount} new, ${preview.duplicateCount} already in Holdr`
        + `${preview.possibleDuplicateCount ? `, ${preview.possibleDuplicateCount} possible duplicates` : ''}`
        + `${preview.pendingPostedCount ? `, ${preview.pendingPostedCount} pending rows that now post` : ''}`;
      if (done && config.clean) {
        fs.rmSync(entry.file, { force: true });
        deleted += 1;
        io.stdout.write(`${head}; already in Holdr: deleted\n`);
      } else {
        io.stdout.write(`${head}; ${counts}${done ? ' (nothing left to import: --clean deletes it)' : ''}\n`);
      }
    } catch (error) {
      io.stdout.write(`${head}; preview unavailable (${describeApiError(error).message})\n`);
    }
  }
  api.close();
  if (holdrProblem) io.stdout.write(`Holdr could not be asked: ${holdrProblem}\n`);
  if (config.clean) io.stdout.write(`${deleted} file(s) deleted.\n`);
  io.stdout.write(`${IMPORT_HINT}\n`);
  return 0;
}

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let config;
  try {
    config = resolveConfig({ argv, env });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    stderr.write(`card-sync: ${error.message}\n`);
    return 2;
  }
  const io = { stdout, stderr };
  switch (config.command) {
    case 'help':
      stdout.write(USAGE);
      return 0;
    case 'pair':
      return pairCommand(config, io);
    case 'check':
      return checkCommand(config, io);
    case 'outbox':
      return outboxCommand(config, io);
    default:
      return startCommand(config, io);
  }
}
