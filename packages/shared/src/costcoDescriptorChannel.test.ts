import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COSTCO_DESCRIPTOR_CHANNELS,
  cardMetalsMerchantClass,
  costcoDescriptorChannel,
  type CostcoDescriptorChannel,
} from './cardSpendingExclusions.js';

// Synthetic descriptors only: made-up store numbers and towns, in the shapes issuers use.
test('Costco descriptor channels are online, gas, warehouse and other, a closed list', () => {
  assert.deepEqual(COSTCO_DESCRIPTOR_CHANNELS, ['online', 'gas', 'warehouse', 'other']);
});

test('a Costco descriptor\'s channel is read from the descriptor alone, case and punctuation aside', () => {
  const table: Array<[string, CostcoDescriptorChannel | null]> = [
    ['COSTCO.COM *ONLINE SAMPLE WA', 'online'],
    ['WWW COSTCO COM', 'online'],
    ['www.costco.com', 'online'],
    ['COSTCO ONLINE SAMPLE', 'online'],
    ['COSTCOCOM SAMPLE', 'online'],
    ['COSTCO GAS #0042', 'gas'],
    ['COSTCO #0042 GAS SAMPLETOWN WA', 'gas'],
    ['COSTCO GASOLINE 0042', 'gas'],
    ['Costco Fuel #0042', 'gas'],
    ['COSTCO WHSE #0042 SAMPLETOWN WA', 'warehouse'],
    ['COSTCO WHOLESALE', 'warehouse'],
    ['Costco Wholesale #0042', 'warehouse'],
    // A town's name is no fuel word.
    ['COSTCO WHSE #0042 GASTONIA NC', 'warehouse'],
    ['COSTCO TRAVEL', 'other'],
    ['COSTCO OPTICAL #0042', 'other'],
    ['COSTCO PHARMACY #0042', 'other'],
    ['COSTCO PHARM #0042', 'other'],
    ['COSTCO RX 0042', 'other'],
    ['COSTCO.COM PHARMACY', 'other'],
    ['COSTCO GAS TRAVEL #0042', 'other'],
    ['SAMS CLUB #0042', null],
    ['SAMPLE STORE', null],
    ['COSTCOMPANY SAMPLE', null],
    ['', null],
  ];
  for (const [description, channel] of table) assert.equal(costcoDescriptorChannel(description), channel, description);
});

test('the channels\' fuel and service words are the metals classes\' never-words: such a descriptor is no class', () => {
  const never = ['COSTCO GAS #0042', 'COSTCO GASOLINE 0042', 'COSTCO FUEL 0042', 'COSTCO TRAVEL', 'COSTCO OPTICAL #0042',
    'COSTCO PHARMACY #0042', 'COSTCO PHARM #0042', 'COSTCO RX 0042', 'SAMS CLUB FUEL #0042'];
  assert.deepEqual(never.map((description) => cardMetalsMerchantClass({ description })), never.map(() => null));
  // And a descriptor without them keeps its class.
  assert.deepEqual(['COSTCO WHSE #0042 GASTONIA NC', 'COSTCO.COM *ONLINE SAMPLE WA'].map((description) => cardMetalsMerchantClass({ description })),
    ['costco-warehouse', 'costco-online']);
});
