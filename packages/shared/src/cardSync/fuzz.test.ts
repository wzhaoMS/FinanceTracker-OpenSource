/**
 * Seeded fuzzing of the card-sync validators. Each iteration takes a valid
 * synthetic fixture, applies random mutations (key insertions including
 * card-number and secret keys, wrong types, huge or deep values, unpaired
 * surrogates, -0, NaN, prototype keys, getters, proxies, cycles) and checks:
 * - the validators never throw and stay within a time budget;
 * - a payload that carries a planted card number or secret anywhere, in a
 *   value or a key, is never accepted;
 * - issues never echo a planted token, card number or secret;
 * - getters are never invoked;
 * - whatever is accepted validates again to the same payload.
 *
 *   CARD_SYNC_FUZZ_SEED=12345 CARD_SYNC_FUZZ_ITERATIONS=20000 npx tsx --test src/cardSync/fuzz.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mergeProjectedBatches } from './capture.js';
import { canonicalJson, type JsonValue } from './canonical.js';
import { validateCardImportAnyVersion } from './dispatch.js';
import { CARD_SYNC_ISSUE_CODES, CARD_SYNC_ISSUE_PATH, type CardSyncIssue } from './issues.js';
import { PROJECTED_BATCH_KNOWN_KEYS, validateProjectedBankBatch } from './projectedBatch.js';
import { snapshotStrictJson } from './strictJson.js';
import { CARD_SYNC_TEXT_LIMITS, prepareCardSyncText } from './text.js';
import { buildCardSyncPayloadV2, CARD_SYNC_V2_KNOWN_KEYS, validateCardSyncPayloadV2, type CardSyncPayloadV2 } from './wireV2.js';
import { CARD_SYNC_V2_FIXTURE_BUILDERS, PROJECTED_BATCH_FIXTURE_BUILDERS } from './__fixtures__/drafts.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Value = any;

const SEED = (Number(process.env.CARD_SYNC_FUZZ_SEED ?? 0x5eed2026) >>> 0) || 1;
const ITERATIONS = Number(process.env.CARD_SYNC_FUZZ_ITERATIONS ?? 5_000);
const TIME_BUDGET_MS = 2_000;

// Published test card numbers only.
const PANS = ['4111111111111111', '371449635398431', '5555555555554444', '6011111111111117', '3530111333300000', '4012888888881881'];
const SECRETS = ['CVV 123', 'cvc: 4567', 'PIN 1234', 'exp 12/29', 'Expiry 2029-12', 'valid thru 12/29', 'security code 999', 'CVV2=0123'];
const PADS = ['\u200b', '\u2060', '\ufeff', '\u00ad', ' ', '\t', '\n', '\u00a0', '\u3000', 'A'];
const KNOWN_KEYS = new Set([...CARD_SYNC_V2_KNOWN_KEYS, ...PROJECTED_BATCH_KNOWN_KEYS]);

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Plan {
  /** Card numbers and secrets planted in this iteration; any of them present means the input must be refused. */
  sensitive: string[];
  /** Harmless unique tokens that must never be echoed by an issue. */
  canaries: string[];
  /** The plant was split across fields or between text and a hint. */
  crossField?: boolean;
}

const getterCalls = { count: 0 };
const proxies = new WeakSet<object>();

/** Proxies and non-plain objects the harness planted; the harness itself never walks into them. */
function isExotic(node: object): boolean {
  if (proxies.has(node)) return true;
  const proto = Object.getPrototypeOf(node);
  return proto !== Object.prototype && proto !== Array.prototype && proto !== null;
}

class Fuzzer {
  constructor(readonly random: () => number) {}

  int(limit: number): number {
    return Math.floor(this.random() * limit);
  }

  pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)];
  }

  chance(probability: number): boolean {
    return this.random() < probability;
  }

  canary(plan: Plan): string {
    const token = `QZXCANARY${this.int(1e9).toString(36)}TOKEN`;
    plan.canaries.push(token);
    return token;
  }

  /** Every property slot in the plain part of the tree, read through descriptors only. */
  slots(root: Value): Array<{ parent: Value; key: string }> {
    const found: Array<{ parent: Value; key: string }> = [];
    const visit = (node: Value, depth: number) => {
      if (depth > 8 || found.length > 4_000) return;
      if (typeof node !== 'object' || node === null || isExotic(node)) return;
      for (const key of Object.keys(node)) {
        const descriptor = Object.getOwnPropertyDescriptor(node, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) continue;
        found.push({ parent: node, key });
        visit(descriptor.value, depth + 1);
      }
    };
    visit(root, 0);
    return found;
  }

  objects(root: Value): Value[] {
    const candidates = [root, ...this.slots(root).map((slot) => Object.getOwnPropertyDescriptor(slot.parent, slot.key)?.value)];
    const objects = candidates.filter((node) => typeof node === 'object' && node !== null && !isExotic(node) && !Array.isArray(node));
    return objects.length > 0 ? objects : [{}];
  }

  plainValue(plan: Plan): Value {
    switch (this.int(22)) {
      case 0: return null;
      case 1: return this.chance(0.5);
      case 2: return this.int(1e6) - 5e5;
      case 3: return this.pick([9_999_999_999, 10_000_000_000, 2 ** 53, -(2 ** 31), 99_999_999_999]);
      case 4: return this.random() * 100;
      case 5: return '';
      case 6: return this.canary(plan);
      case 7: return 'x'.repeat(this.pick([501, 1_024, 1_025, 5_000]));
      case 8: return this.pick(['2026-02-30', '2026-13-01', '2100-01-01', '1969-12-31', '2026-9-1', '2026-10-16T00:00:00Z']);
      case 9: return this.pick(['pending', 'posted', 'removed', 'purchase', 'chase-api', 'wf-dom', 'USD', 'EUR', 'end-marker', 'complete']);
      case 10: return [];
      case 11: return {};
      case 12: return Array.from({ length: this.pick([3, 21, 41, 2_001]) }, () => this.int(10));
      case 13: {
        let nested: Value = this.int(10);
        for (let level = this.pick([3, 6, 12]); level > 0; level -= 1) nested = [nested];
        return nested;
      }
      case 14: return `lone ${this.pick(['\ud800', '\udfff', '\ud83d'])} surrogate`;
      case 15: return -0;
      case 16: return this.pick([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
      case 17: return `xid1:${'abcdefghijklmnop'.repeat(4)}`;
      case 18: return `scp_${'abcdefghijklmnop'.repeat(2)}`;
      case 19: return { start: '2026-09-01', end: '2026-08-01', dateBasis: 'transaction' };
      case 20: return 'SYNTHETIC  DOUBLE  SPACE';
      default: return `=${this.canary(plan)}`;
    }
  }

  structural(root: Value, plan: Plan): Value {
    const slots = this.slots(root);
    const objects = this.objects(root);
    switch (this.int(8)) {
      case 0: {
        if (slots.length === 0) return root;
        const slot = this.pick(slots);
        if (Array.isArray(slot.parent)) slot.parent.splice(Number(slot.key), 1);
        else delete slot.parent[slot.key];
        return root;
      }
      case 1: {
        const object = this.pick(objects);
        const keys = Object.keys(object);
        if (keys.length === 0) return root;
        const key = this.pick(keys);
        const value = object[key];
        delete object[key];
        object[this.pick([...KNOWN_KEYS, this.canary(plan), 'notes', 'userCategory', 'rawData', 'metadata'])] = value;
        return root;
      }
      case 2: {
        const object = this.pick(objects);
        const key = this.pick([...KNOWN_KEYS, this.canary(plan), 'extra', 'url', 'headers', 'cardMemberName', 'accountToken', 'removed']);
        object[key] = this.plainValue(plan);
        return root;
      }
      case 3: {
        if (slots.length === 0) return root;
        const slot = this.pick(slots);
        slot.parent[slot.key] = this.plainValue(plan);
        return root;
      }
      case 4: {
        const numbers = slots.filter((slot) => typeof slot.parent[slot.key] === 'number');
        if (numbers.length === 0) return root;
        const slot = this.pick(numbers);
        slot.parent[slot.key] += this.pick([1, -1, 100]);
        return root;
      }
      case 5: {
        const list = root.rows ?? root.transactions ?? root.accounts;
        if (!Array.isArray(list) || list.length === 0) return root;
        const index = this.int(list.length);
        switch (this.int(4)) {
          case 0: list.push(JSON.parse(JSON.stringify(list[index]))); break;
          case 1: list.splice(index, 1); break;
          case 2: list.reverse(); break;
          default: [list[0], list[index]] = [list[index], list[0]];
        }
        return root;
      }
      case 6: {
        const strings = slots.filter((slot) => typeof slot.parent[slot.key] === 'string');
        if (strings.length === 0) return root;
        const slot = this.pick(strings);
        const text: string = slot.parent[slot.key];
        slot.parent[slot.key] = this.pick([
          `${text}  `, `=${text}`, `${text.slice(0, 1)}\u200b${text.slice(1)}`, text.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0)),
          `${text} ${this.canary(plan)}`, text.toLowerCase(), `${text}\u0600`,
        ]);
        return root;
      }
      default: {
        const object = this.pick(objects);
        Object.defineProperty(object, '__proto__', { value: { polluted: this.canary(plan) }, enumerable: true, configurable: true, writable: true });
        return root;
      }
    }
  }

  exotic(root: Value, plan: Plan): Value {
    const slots = this.slots(root);
    if (slots.length === 0) return root;
    const slot = this.pick(slots);
    const current = slot.parent[slot.key];
    switch (this.int(14)) {
      case 0: slot.parent[slot.key] = undefined; break;
      case 1: slot.parent[slot.key] = () => this.canary(plan); break;
      case 2: slot.parent[slot.key] = Symbol(this.canary(plan)); break;
      case 3: slot.parent[slot.key] = BigInt(this.int(1e6)); break;
      case 4:
        Object.defineProperty(slot.parent, slot.key, {
          get: () => { getterCalls.count += 1; return current; },
          enumerable: true,
          configurable: true,
        });
        break;
      case 5: Object.defineProperty(slot.parent, slot.key, { value: current, enumerable: false, configurable: true, writable: true }); break;
      case 6: slot.parent[Symbol(this.canary(plan))] = 1; break;
      case 7: {
        class Row {
          value = 1;
        }
        slot.parent[slot.key] = this.pick([new Date(0), new Map([[1, 2]]), new Row(), new Uint8Array(3), Object.create({ inherited: 1 }), new String('x')]);
        break;
      }
      case 8: {
        const target = typeof current === 'object' && current !== null ? current : {};
        const proxy = this.chance(0.5)
          ? new Proxy(target, { ownKeys: () => { throw new Error(this.canary(plan)); } })
          : new Proxy(target, { getOwnPropertyDescriptor: (object, key) => Reflect.getOwnPropertyDescriptor(object, key) });
        proxies.add(proxy);
        slot.parent[slot.key] = proxy;
        break;
      }
      case 9: {
        const { proxy, revoke } = Proxy.revocable({}, {});
        proxies.add(proxy);
        revoke();
        slot.parent[slot.key] = proxy;
        break;
      }
      case 10: slot.parent[slot.key] = root; break;
      case 11: {
        const array = Array.isArray(current) && current.length > 0 ? current : [1, 2, 3];
        delete array[0];
        slot.parent[slot.key] = array;
        break;
      }
      case 12: slot.parent[slot.key] = this.chance(0.5) ? Array.from({ length: 100_000 }, () => 0) : 'y'.repeat(200_000); break;
      default: {
        let nested: Value = 1;
        for (let level = 0; level < 5_000; level += 1) nested = [nested];
        slot.parent[slot.key] = nested;
      }
    }
    return root;
  }

  panForm(pan: string): string {
    const groups = pan.match(/.{1,4}/g)!;
    const pad = this.pick(PADS);
    const forms = [
      pan, groups.join(' '), groups.join('-'), groups.join('\u2013'), [...pan].join('\u200b'), [...pan].join(' '),
      pan.replace(/\d/g, (digit) => String.fromCharCode(0xff10 + Number(digit))),
      pan.replace(/\d/g, (digit) => String.fromCharCode(0x0660 + Number(digit))),
      `${pad.repeat(this.pick([CARD_SYNC_TEXT_LIMITS.issuerCategory, CARD_SYNC_TEXT_LIMITS.merchant, CARD_SYNC_TEXT_LIMITS.description, 1_024]) - this.int(pan.length + 1))}${pan}`,
      `PAY ${pad.repeat(this.int(20))}${pan}${pad.repeat(this.int(20))} THANK YOU`,
    ];
    return this.pick(forms);
  }

  /**
   * Splits a planted card number across one row's text fields (two or three pieces meeting at the
   * field boundaries), between its text and a card hint (`cards`, a candidate's `last4` or the row's
   * `cardLast4`), or into whole fragments between words with the last four kept by a `***` redaction
   * or given as a hint, over description and merchant. Always the last mutation of an iteration.
   */
  crossField(root: Value, plan: Plan): Value {
    const rows = Array.isArray(root.rows) ? root.rows : Array.isArray(root.transactions) ? root.transactions : null;
    if (!rows || rows.length === 0) return root;
    const row: Value = this.pick(rows);
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return root;
    const pan = this.pick(PANS);
    const word = this.pick(['PAY', 'REF', 'SYNTHETIC', 'STORE']);
    const last4 = pan.slice(-4);
    const hint = () => {
      if (Array.isArray(root.rows)) {
        root.cards = [...new Set([...(Array.isArray(root.cards) ? root.cards : []), last4])].sort();
      } else if (Array.isArray(root.accounts) && root.accounts.length > 0 && this.chance(0.5)) {
        root.accounts[0].last4 = last4;
      } else {
        row.cardLast4 = last4;
      }
    };
    switch (this.int(4)) {
      case 0: {
        const cut = 4 + this.int(pan.length - 8);
        [row.description, row.merchant] = this.chance(0.5)
          ? [`${word} ${pan.slice(0, cut)}`, `${pan.slice(cut)} ${word}`]
          : [`${pan.slice(cut)} ${word}`, `${word} ${pan.slice(0, cut)}`];
        break;
      }
      case 1: {
        const first = 3 + this.int(4);
        const second = first + 3 + this.int(4);
        row.description = `${word} ${pan.slice(0, first)}`;
        row.merchant = pan.slice(first, second);
        row.issuerCategory = `${pan.slice(second)} ${word}`;
        break;
      }
      case 2:
        row.description = `${word} ${pan.slice(0, -4)}`;
        hint();
        break;
      default: {
        const body = pan.slice(0, -4);
        const cuts = new Set<number>();
        for (let count = 1 + this.int(3); cuts.size < count;) cuts.add(1 + this.int(body.length - 1));
        const ends = [...[...cuts].sort((a, b) => a - b), body.length];
        const words = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO'];
        const parts = ends.flatMap((end, index) => [words[index], body.slice(index === 0 ? 0 : ends[index - 1], end)]);
        if (this.chance(0.5)) parts.splice(1 + 2 * this.int(ends.length + 1), 0, `***${last4}`);
        else hint();
        const split = 1 + this.int(parts.length);
        row.description = parts.slice(0, split).join(' ');
        row.merchant = split < parts.length ? parts.slice(split).join(' ') : null;
      }
    }
    plan.sensitive.push(pan);
    plan.crossField = true;
    return root;
  }

  /** Plants a card number or secret somewhere; always the last mutation of an iteration. */
  sensitive(root: Value, plan: Plan): Value {
    const pan = this.pick(PANS);
    const objects = this.objects(root);
    const slots = this.slots(root);
    switch (this.int(6)) {
      case 0: {
        const text = this.panForm(pan);
        if (slots.length === 0) return root;
        const slot = this.pick(slots);
        slot.parent[slot.key] = text;
        plan.sensitive.push(text);
        return root;
      }
      case 1: {
        const key = this.pick([pan, pan.match(/.{1,4}/g)!.join('-'), `card ${pan}`, [...pan].join('\u200b')]);
        this.pick(objects)[key] = this.plainValue(plan);
        plan.sensitive.push(key);
        return root;
      }
      case 2: {
        if (slots.length === 0) return root;
        const slot = this.pick(slots);
        slot.parent[slot.key] = Number(pan);
        plan.sensitive.push(pan);
        return root;
      }
      case 3: {
        if (slots.length === 0) return root;
        const secret = this.pick(SECRETS);
        const slot = this.pick(slots);
        slot.parent[slot.key] = this.chance(0.5) ? secret : `SYNTHETIC ${secret} STORE`;
        plan.sensitive.push(secret);
        return root;
      }
      case 4: {
        const [key, value] = this.pick([['x_cvv', '123'], ['cvv', '987'], ['pin', 4321], ['expDate', '12/29'], ['x_pin_code', '9876'], ['securityCode', '321']] as const);
        this.pick(objects)[key] = value;
        plan.sensitive.push(String(value));
        return root;
      }
      default: {
        const key = this.pick(SECRETS);
        this.pick(objects)[key] = 1;
        plan.sensitive.push(key);
        return root;
      }
    }
  }
}

function panWindows(text: string): string[] {
  const windows: string[] = [];
  for (let index = 0; index + 5 <= text.length; index += 1) windows.push(text.slice(index, index + 5));
  return windows;
}

function assertIssuesSafe(issues: readonly CardSyncIssue[], plan: Plan, label: string): void {
  for (const issue of issues) {
    assert.deepEqual(Object.keys(issue).sort(), ['code', 'path'], label);
    assert.ok((CARD_SYNC_ISSUE_CODES as readonly string[]).includes(issue.code), label);
    assert.match(issue.path, CARD_SYNC_ISSUE_PATH, label);
    for (const segment of issue.path.match(/\.([A-Za-z][A-Za-z0-9]*)/g) ?? []) assert.ok(KNOWN_KEYS.has(segment.slice(1)), label);
  }
  const text = JSON.stringify(issues);
  for (const token of [...plan.canaries, ...plan.sensitive]) assert.ok(!text.includes(token), `${label}: an issue echoes input`);
  for (const pan of PANS) for (const window of panWindows(pan)) assert.ok(!text.includes(window), `${label}: an issue echoes card digits`);
}

describe('fuzz: card-sync validators', () => {
  const v2Bases = Object.values(CARD_SYNC_V2_FIXTURE_BUILDERS).map((build) => JSON.stringify(build()));
  const projectedBases = Object.values(PROJECTED_BATCH_FIXTURE_BUILDERS).map((build) => JSON.stringify(build()));

  it(`survives ${ITERATIONS} seeded mutations (seed ${SEED}) without throwing, leaking or accepting card data`, (context) => {
    const fuzzer = new Fuzzer(mulberry32(SEED));
    const stats = { accepted: 0, refused: 0, sensitive: 0, crossField: 0, maxMs: 0, totalMs: 0, codes: new Map<string, number>() };
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const projected = fuzzer.chance(0.3);
      let value: Value = JSON.parse(fuzzer.pick(projected ? projectedBases : v2Bases));
      const plan: Plan = { sensitive: [], canaries: [] };
      const steps = 1 + fuzzer.int(3);
      // A harness step may meet an exotic value an earlier step planted; it is then skipped. Only
      // validator exceptions count as failures.
      const apply = (step: (root: Value, plan: Plan) => Value) => {
        try {
          value = step.call(fuzzer, value, plan);
        } catch {
          // skipped
        }
      };
      for (let step = 0; step < steps; step += 1) apply(fuzzer.chance(0.25) ? fuzzer.exotic : fuzzer.structural);
      if (fuzzer.chance(0.35)) {
        const planted = plan.sensitive.length;
        apply(fuzzer.chance(0.3) ? fuzzer.crossField : fuzzer.sensitive);
        // A plant that did not land (its step was skipped) plants nothing.
        if (plan.sensitive.length === planted) plan.sensitive.length = planted;
      }
      const label = `seed ${SEED} iteration ${iteration}`;
      const calls = getterCalls.count;
      let result: ReturnType<typeof validateCardSyncPayloadV2> | ReturnType<typeof validateProjectedBankBatch>;
      let merged: ReturnType<typeof mergeProjectedBatches> | null = null;
      const started = performance.now();
      try {
        result = projected ? validateProjectedBankBatch(value) : validateCardSyncPayloadV2(value);
        if (!projected && iteration % 4 === 0) validateCardImportAnyVersion(value);
        if (projected && iteration % 5 === 0) merged = mergeProjectedBatches([value]);
        if (iteration % 7 === 0) snapshotStrictJson(value);
      } catch (error) {
        assert.fail(`${label}: a validator threw ${(error as Error).name}`);
      }
      if (merged) {
        // One batch merged is that batch, validated: the same verdict and the same bytes.
        assert.equal(merged.ok, result.ok, `${label}: merge disagrees with validation`);
        if (merged.ok && 'batch' in result) assert.equal(canonicalJson(merged.batch as unknown as JsonValue), canonicalJson(result.batch as unknown as JsonValue), label);
        if (!merged.ok) assertIssuesSafe(merged.issues, plan, label);
      }
      const elapsed = performance.now() - started;
      stats.maxMs = Math.max(stats.maxMs, elapsed);
      stats.totalMs += elapsed;
      assert.ok(elapsed < TIME_BUDGET_MS, `${label}: took ${elapsed.toFixed(0)} ms`);
      assert.equal(getterCalls.count, calls, `${label}: a getter ran`);
      if (plan.sensitive.length > 0) {
        stats.sensitive += 1;
        if (plan.crossField) stats.crossField += 1;
        assert.equal(result.ok, false, `${label}: accepted a planted card number or secret`);
      }
      if (result.ok) {
        stats.accepted += 1;
        const output = 'payload' in result ? result.payload : result.batch;
        const again = 'payload' in result ? validateCardSyncPayloadV2(output) : validateProjectedBankBatch(output);
        assert.ok(again.ok, label);
        assert.equal(canonicalJson(('payload' in again ? again.payload : again.batch) as unknown as JsonValue), canonicalJson(output as unknown as JsonValue), label);
      } else {
        stats.refused += 1;
        assertIssuesSafe(result.issues, plan, label);
        for (const issue of result.issues) stats.codes.set(issue.code, (stats.codes.get(issue.code) ?? 0) + 1);
      }
    }
    assert.ok(stats.sensitive > ITERATIONS / 5);
    assert.ok(stats.crossField > ITERATIONS / 50);
    context.diagnostic(`seed ${SEED}: ${ITERATIONS} mutations, ${stats.refused} refused, ${stats.accepted} accepted, ${stats.sensitive} with planted card data or secrets (all refused), ${stats.crossField} of them split across fields or hints`);
    context.diagnostic(`time per validation: max ${stats.maxMs.toFixed(1)} ms, mean ${(stats.totalMs / ITERATIONS).toFixed(2)} ms; ${stats.codes.size} distinct issue codes`);
  });

  it('refuses padded card numbers that straddle any text limit, in any field, at payload level', () => {
    const fields: Array<[keyof typeof CARD_SYNC_TEXT_LIMITS, number]> = [
      ['description', CARD_SYNC_TEXT_LIMITS.description], ['merchant', CARD_SYNC_TEXT_LIMITS.merchant], ['issuerCategory', CARD_SYNC_TEXT_LIMITS.issuerCategory],
    ];
    let checked = 0;
    for (const pan of ['4111111111111111', '371449635398431']) {
      for (const [field, limit] of fields) {
        for (const pad of PADS) {
          for (const edge of [limit, 1_024]) {
            for (let inside = 0; inside <= pan.length; inside += 3) {
              const text = `${pad.repeat(Math.max(0, edge - inside))}${pan}`;
              const payload = JSON.parse(v2Bases[0]);
              payload.rows[0][field] = text;
              const result = validateCardSyncPayloadV2(payload);
              checked += 1;
              assert.equal(result.ok, false, `${field} ${JSON.stringify(pad)} ${inside}`);
              assertIssuesSafe(result.ok ? [] : result.issues, { sensitive: [pan, text], canaries: [] }, field);
            }
          }
        }
      }
    }
    assert.ok(checked > 500);
  });

  it('refuses every split of a card number across fields, between text and a card hint, or into fragments', () => {
    const base = JSON.parse(v2Bases[0]);
    let checked = 0;
    for (const pan of ['4242424242424242', '371449635398431', '5555555555554444']) {
      for (let cut = 1; cut < pan.length; cut += 1) {
        const payload = JSON.parse(JSON.stringify(base));
        payload.rows[2].description = `PAY ${pan.slice(0, cut)}`;
        payload.rows[2].merchant = `${pan.slice(cut)} STORE`;
        const result = validateCardSyncPayloadV2(payload);
        assert.equal(result.ok, false, `${pan} cut ${cut}`);
        checked += 1;
        for (let second = cut + 1; second < pan.length; second += 1) {
          const three = JSON.parse(JSON.stringify(base));
          three.rows[2].description = `PAY ${pan.slice(0, cut)}`;
          three.rows[2].merchant = pan.slice(cut, second);
          three.rows[2].issuerCategory = `${pan.slice(second)} STORE`;
          assert.equal(validateCardSyncPayloadV2(three).ok, false, `${pan} cuts ${cut} ${second}`);
          checked += 1;
        }
      }
      // Whole fragments between words, the last four kept by a redaction, in one field or two.
      const body = pan.slice(0, -4);
      for (let first = 1; first < body.length; first += 1) {
        for (let second = first + 1; second < body.length; second += 1) {
          const text = `ALPHA ${body.slice(0, first)} BRAVO ***${pan.slice(-4)} CHARLIE ${body.slice(first, second)} DELTA ${body.slice(second)}`;
          const one = JSON.parse(JSON.stringify(base));
          one.rows[2].description = text;
          assert.equal(validateCardSyncPayloadV2(one).ok, false, `${pan} fragments ${first} ${second}`);
          const two = JSON.parse(JSON.stringify(base));
          two.rows[2].description = text.slice(0, text.indexOf(' DELTA'));
          two.rows[2].merchant = text.slice(text.indexOf('DELTA'));
          assert.equal(validateCardSyncPayloadV2(two).ok, false, `${pan} fragments ${first} ${second} in two fields`);
          checked += 2;
        }
      }
      const hinted = JSON.parse(JSON.stringify(base));
      hinted.rows[2].description = `PAY ${pan.slice(0, -4)}`;
      hinted.cards = [...new Set([...hinted.cards, pan.slice(-4)])].sort();
      assert.deepEqual(validateCardSyncPayloadV2(hinted), { ok: false, issues: [{ code: 'card-data', path: '$.rows[2]' }] }, pan);
    }
    assert.ok(checked > 300);
  });

  it('never lets a card-number prefix through the adapter path either', () => {
    // Producer path: padded issuer text goes through prepareCardSyncText, then into a built payload.
    const base = JSON.parse(v2Bases[0]) as CardSyncPayloadV2;
    const { format: _format, version: _version, totals: _totals, rows, ...header } = base;
    let accepted = 0;
    for (const pan of ['4111111111111111', '5555555555554444']) {
      for (const pad of PADS) {
        for (const limit of [CARD_SYNC_TEXT_LIMITS.merchant, CARD_SYNC_TEXT_LIMITS.description]) {
          for (let inside = 0; inside <= pan.length; inside += 1) {
            const prepared = prepareCardSyncText(`${pad.repeat(Math.max(0, limit - inside))}${pan}`, limit);
            if (!prepared.ok || prepared.text === null) continue;
            const draftRows = rows.map(({ fingerprint: _fingerprint, ...row }, index) => (index === 0
              ? { ...row, [limit === CARD_SYNC_TEXT_LIMITS.merchant ? 'merchant' : 'description']: prepared.text }
              : row));
            const result = buildCardSyncPayloadV2({ ...header, rows: draftRows });
            assert.ok(result.ok, JSON.stringify(result.ok ? [] : result.issues));
            accepted += 1;
            const digits = canonicalJson(result.payload as unknown as JsonValue).replace(/[^0-9]/g, ' ');
            for (const window of panWindows(pan)) assert.ok(!digits.includes(window), `${JSON.stringify(pad)} ${limit} ${inside}`);
          }
        }
      }
    }
    assert.ok(accepted > 100);
  });
});
