#!/usr/bin/env node
// Holdr card sync receiver (experimental): the local half of the American Express sync agent. It listens on 127.0.0.1
// only, takes statement exports from the paired browser extension over an encrypted channel, converts them into Holdr's
// redacted card-import JSON in a private outbox, and asks your local Holdr for a preview. See docs/sync-agent.md.
//
//   node --import tsx agents/card-sync/receiver.mjs [start | pair | check | outbox | help] [options]
//   node agents/card-sync/receiver.mjs ...            (works too: the receiver loads tsx itself)
import { main } from './lib/cli.mjs';

process.exitCode = await main(process.argv.slice(2));
