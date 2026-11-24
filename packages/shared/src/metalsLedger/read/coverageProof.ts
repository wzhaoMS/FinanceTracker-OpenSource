/**
 * `METALS_COVERAGE_PROOF_RULE` v1 ('metals-coverage-proof-v1', card cross-check design v3.2 §6–§8; G1d C5–C7): gate (b)'s
 * served proof that the history a result needs is complete, or the named gaps that keep it incomplete, with the card
 * check's gap catalog from the same computation, so every row's citation resolves at one snapshot.
 *
 * - Scopes: `asOf`, household-wide, needs every used source's buy and sell kinds over [acquisitionStart, asOf]; one sales
 *   scope per metal with an included sale needs buy kinds through its last included sale and sell kinds through asOf. A
 *   metal with none reads `no-sales`: no need, no gaps, never complete.
 * - Gaps (§6.4): imported windows (metalsCoverageOf, the measures' own arithmetic, C5), missing accounts and kinds, card-row
 *   inferences (unsupported dealers, unresolved processors, unexplained mixed charges), other places and ways, the roster,
 *   an unknown acquisitionStart and a failed card check. A card row on or after acquisitionStart enters every scope with a
 *   need (R6: no settlement bound is invented); one wholly before it enters none.
 * - Exemptions (§6.5): a stored answer's evidence-bound binding removes only the card-row trigger it names, only while its
 *   digest matches and the roster is current; a mixed source's only in a scope with every imported window complete (R3).
 * - The catalog (C6) cites each non-explained row from the same trigger accounting, so each card-row gap's count equals
 *   the rows citing it. Card history (C7) is a limit, never a gap: it changes no gap, scope or total.
 *
 * Pure: no file system, network or clock.
 */

import type {
  MetalsAccountRef,
  MetalsCardCheckGap,
  MetalsCoverageGap,
  MetalsCoverageLimit,
  MetalsCoverageNeed,
  MetalsCoverageProof,
  MetalsCoverageScope,
  MetalsGapExemption,
  MetalsGapTrigger,
  MetalsRosterBindingState,
  MetalsRosterProblem,
  MetalsRosterState,
  MetalsSalesScope,
  MetalsSourceRosterAnswer,
} from '../../metalsApi.js';
import { METALS_SOURCES, type Metal, type MetalsCoverageKind, type MetalsSide, type MetalsSource } from '../model.js';
import { metalsBindingDigest, metalsBindingEvidence, metalsBindingKeyOf, type MetalsBindingKey } from './bindingDigest.js';
import type { MetalsCardCaptureResult, MetalsCardCaptureRow } from './capture.js';
import { metalsMerchantClass } from './cardGraph.js';
import { metalsCoverageOf, metalsRangeCoverage, type MetalsStatedCoverage } from './coverage.js';

export const METALS_COVERAGE_PROOF_RULE = 'metals-coverage-proof-v1' as const;

export type MetalsRosterClaim = 'no-metal-purchases' | 'accounts-complete';

/** The stored roster answer (§7.2) with what the server computed when it was answered. */
export interface MetalsRosterAnswerStored {
  answer: MetalsSourceRosterAnswer;
  decidedAt: string;
  exemptions: Array<{ key: MetalsBindingKey; claim: MetalsRosterClaim; digest: string; rows: number }>;
  importedAccountsAtAnswer: Array<{ accountId: string; source: MetalsSource; retired: boolean }>;
  sourcesAtAnswer: MetalsSource[];
}

export interface MetalsCoverageProofInput {
  snapshot: string;
  asOf: string;
  today: string;
  /** METALS_SOURCES at read time. */
  sources: readonly MetalsSource[];
  importedAccounts: ReadonlyArray<{ accountId: string; source: MetalsSource; label: string; retired: boolean }>;
  /** Known imports only (H7). */
  coverage: readonly MetalsStatedCoverage[];
  /** Admitted, as of asOf. */
  records: {
    buys: ReadonlyArray<{ source: MetalsSource; metal: Metal | null; date: string }>;
    sales: ReadonlyArray<{ source: MetalsSource; metal: Metal | null; agreedDay: string; included: boolean }>;
    metalUnknown: { lots: number; saleLines: number };
  };
  /** null: the card check failed. */
  capture: MetalsCardCaptureResult | null;
  roster: { installed: boolean; asking: boolean; stored: MetalsRosterAnswerStored | null };
  /** C7: per held card account, its card rows' known coverage (Spending's), for the card-history limit. */
  cardHistory: ReadonlyArray<{ accountId: string; covered: ReadonlyArray<{ from: string; to: string }> }>;
}

export interface MetalsCoverageCatalog {
  /** The card check's gap catalog, by id: financial entries name the proof scopes carrying them; diagnostics name none. */
  gaps: MetalsCardCheckGap[];
  /** Every non-explained in-scope purchase row → the catalog ids it cites, each resolving in `gaps`. */
  rowGaps: Map<string, string[]>;
  /** C7: only accounts with unsynced days over [acquisitionStart ?? earliest admitted record ?? asOf, asOf]; days ascending. */
  cardHistory: Array<{ accountId: string; unsynced: Array<{ from: string; to: string }> }>;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const SIDES: readonly MetalsSide[] = ['buy', 'sell'];
/** The coverage kinds a source's capture states, per side (collectpure states no purchases; costco and walmart no sales). */
const KINDS: Readonly<Record<MetalsSide, Readonly<Record<MetalsSource, readonly MetalsCoverageKind[]>>>> = {
  buy: { costco: ['online', 'warehouse'], walmart: ['online'], collectpure: [] },
  sell: { costco: [], walmart: [], collectpure: ['sell-orders'] },
};
const LIMITS: readonly MetalsCoverageLimit[] = [
  'card-check-only', 'non-card-funding', 'stored-value-only', 'warehouse-and-store', 'cards-not-in-holdr', 'undiscovered-dealers',
];
/** MetalsRosterProblem's order; the first three are staleness, the rest contradictions. */
const PROBLEMS: readonly MetalsRosterProblem[] = [
  'accounts-changed', 'sources-changed', 'evidence-changed', 'start-after-admitted-record', 'start-after-gold-row', 'unused-source-has-buys',
  'unused-source-has-sales', 'all-imported-but-none', 'exemption-disagrees', 'sources-incomplete', 'answer-shape',
];
const STALENESS: ReadonlySet<MetalsRosterProblem> = new Set<MetalsRosterProblem>(['accounts-changed', 'sources-changed', 'evidence-changed']);
const BEFORE_START = 'diag|before-acquisition-start';
const EXEMPTED = 'diag|exempted';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isInteger = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(Date.parse(`${value}T00:00:00Z`)).toISOString().slice(0, 10) === value;
const isSource = (value: unknown): value is MetalsSource => typeof value === 'string' && (METALS_SOURCES as readonly string[]).includes(value);
const isClaim = (value: unknown): value is MetalsRosterClaim => value === 'no-metal-purchases' || value === 'accounts-complete';

/** A source's `accounts`: null, 'all-imported', or a count from 1 to 99 not imported. */
const accountsShaped = (value: unknown) => value === null || value === 'all-imported' || (isRecord(value) && isInteger(value.notImported, 1, 99));
const sourceShaped = (value: unknown) => isRecord(value) && isSource(value.source) && typeof value.bought === 'boolean'
  && typeof value.sold === 'boolean' && accountsShaped(value.accounts);
const exemptionShaped = (value: unknown) => isRecord(value) && typeof value.key === 'string' && isClaim(value.claim);

/** `answer-shape` (§7.5): every field within its type, re-checked on read as defence in depth. */
function answerShaped(answer: unknown, today: string): answer is MetalsSourceRosterAnswer {
  if (!isRecord(answer)) return false;
  const start = answer.acquisitionStart;
  const sources = answer.sources;
  const elsewhere = answer.elsewhere;
  const exemptions = answer.exemptions;
  return isDay(start) && start.endsWith('-01') && start <= today
    && Array.isArray(sources) && sources.every(sourceShaped)
    && isRecord(elsewhere) && isInteger(elsewhere.places, 0, 99)
    && typeof answer.otherWays === 'boolean'
    && Array.isArray(exemptions) && exemptions.every(exemptionShaped);
}

/** A binding key the preview can show: a supported source, or a dealer, generic-merchant or processor group. */
const bindingKeyShown = (key: string) => (key.startsWith('source:') ? isSource(key.slice('source:'.length))
  : key.startsWith('group:') && /^(?:dealer|merchant|unresolved):./.test(key.slice('group:'.length)));
const sourceOfKey = (key: string): MetalsSource | null => {
  const source = key.startsWith('source:') ? key.slice('source:'.length) : null;
  return isSource(source) ? source : null;
};
/** A mixed source: one whose online channel has a card merchant class (Costco, Walmart). */
const isMixed = (source: MetalsSource) => metalsMerchantClass(source, 'online') !== null;
const sameSet = (a: readonly string[], b: readonly string[]) => {
  const left = [...new Set(a)].sort(compareText);
  const right = [...new Set(b)].sort(compareText);
  return left.length === right.length && left.every((value, index) => value === right[index]);
};
const sameList = (a: readonly string[], b: readonly string[]) => {
  const left = [...a].sort(compareText);
  const right = [...b].sort(compareText);
  return left.length === right.length && left.every((value, index) => value === right[index]);
};

/** Computes the proof and the card check's catalog from one input version (§6.1): every gap, scope, total and citation. */
export function metalsCoverageProof(input: MetalsCoverageProofInput): { proof: MetalsCoverageProof; catalog: MetalsCoverageCatalog } {
  const capture = input.capture;
  const stored = input.roster.installed ? input.roster.stored : null;
  // An answer outside its type is read as no answer at all (and contradicts the roster): fail-closed.
  const answer = stored !== null && answerShaped(stored.answer, input.today) ? stored.answer : null;
  const decidedAt = answer !== null && stored !== null ? stored.decidedAt : null;
  const acqStart = answer === null ? null : answer.acquisitionStart;
  const imported = input.importedAccounts.filter((account) => !account.retired);
  const importedOf = (source: MetalsSource) => imported.filter((account) => account.source === source)
    .sort((a, b) => compareText(a.accountId, b.accountId));
  // A retired account (a correction state this build's reads refuse, so unreachable today) still needs its windows, and
  // never counts as imported: both can only refuse more.
  const windowAccountsOf = (source: MetalsSource) => input.importedAccounts.filter((account) => account.source === source)
    .sort((a, b) => compareText(a.accountId, b.accountId));
  const refOf = (account: { accountId: string; source: MetalsSource; label: string }): MetalsAccountRef =>
    ({ accountId: account.accountId, source: account.source, label: account.label });
  const recordsOn = (side: MetalsSide, source: MetalsSource) => (side === 'buy'
    ? input.records.buys.filter((record) => record.source === source).length
    : input.records.sales.filter((record) => record.source === source).length);
  const entryOf = (source: MetalsSource) => answer?.sources.find((entry) => entry.source === source) ?? null;
  const rosterSays = (side: MetalsSide, source: MetalsSource) => {
    const entry = entryOf(source);
    return entry !== null && (side === 'buy' ? entry.bought : entry.sold);
  };
  // Used for windows: admitted records on that side, or the stored answer, current or not (§6.3).
  const usedFor = (side: MetalsSide, source: MetalsSource) => recordsOn(side, source) > 0 || rosterSays(side, source);

  // Card rows: the non-explained in-scope purchases; a row wholly before acquisitionStart enters no scope (§5.1).
  const open = capture === null ? [] : capture.rows.filter((row) => row.status !== 'explained');
  const before = (row: MetalsCardCaptureRow) => acqStart !== null && row.date < acqStart;
  const counted = open.filter((row) => !before(row));

  // Bindings: each stored exemption's evidence recomputed on this read; unverifiable without a capture.
  const digestAccounts = input.importedAccounts.map(({ accountId, source, retired }) => ({ accountId, source, retired }));
  const exemptions: MetalsRosterAnswerStored['exemptions'] = stored === null ? [] : stored.exemptions;
  const bindings = exemptions.map((exemption) => {
    if (capture === null) return { key: exemption.key, claim: exemption.claim, rows: exemption.rows, current: false };
    const evidence = metalsBindingEvidence(capture, exemption.key, digestAccounts);
    return { key: exemption.key, claim: exemption.claim, rows: evidence.rows, current: metalsBindingDigest(evidence) === exemption.digest };
  });
  const bound = (key: string, claim: MetalsRosterClaim, current: boolean) =>
    bindings.some((binding) => binding.key === key && binding.claim === claim && binding.current === current);

  // Gold-only rows before acquisitionStart: bound by a current no-metal-purchases binding (its digest alone), or they
  // contradict the roster (`start-after-gold-row`) and cite `roster`. Mixed rows there are diagnostic.
  const coveredBefore = (row: MetalsCardCaptureRow) => {
    const key = metalsBindingKeyOf(row);
    return key !== null && bound(key, 'no-metal-purchases', true);
  };
  const goldBefore = open.filter((row) => row.scope === 'gold-only' && before(row));
  const rosterRows = goldBefore.filter((row) => !coveredBefore(row)).map((row) => row.rowId);
  const exemptBefore = goldBefore.filter(coveredBefore).map((row) => row.rowId);
  const mixedBefore = open.filter((row) => row.scope === 'mixed-online' && before(row)).map((row) => row.rowId);

  const claimValid = (key: string, claim: MetalsRosterClaim): boolean => {
    if (key.startsWith('group:')) return claim === 'no-metal-purchases';
    const source = sourceOfKey(key);
    const entry = source === null ? null : entryOf(source);
    if (source === null || entry === null) return false;
    return claim === 'no-metal-purchases' ? !entry.bought : isMixed(source) && entry.accounts === 'all-imported' && importedOf(source).length > 0;
  };

  // The roster's problems (§7.5): contradictions outrank staleness.
  const problems = new Set<MetalsRosterProblem>();
  if (stored !== null) {
    if (answer === null) problems.add('answer-shape');
    else {
      const start = answer.acquisitionStart;
      if (input.records.buys.some((record) => record.date < start) || input.records.sales.some((record) => record.agreedDay < start)) {
        problems.add('start-after-admitted-record');
      }
      if (rosterRows.length > 0) problems.add('start-after-gold-row');
      for (const entry of answer.sources) {
        if (!entry.bought && recordsOn('buy', entry.source) > 0) problems.add('unused-source-has-buys');
        if (!entry.sold && recordsOn('sell', entry.source) > 0) problems.add('unused-source-has-sales');
        if ((entry.bought || entry.sold) && entry.accounts === 'all-imported' && importedOf(entry.source).length === 0) problems.add('all-imported-but-none');
      }
      const claims = (list: ReadonlyArray<{ key: string; claim: string }>) => list.map((entry) => `${entry.key}\u0000${entry.claim}`);
      const keys = answer.exemptions.map((entry) => entry.key);
      if (new Set(keys).size !== keys.length || !sameList(claims(answer.exemptions), claims(stored.exemptions))
        || answer.exemptions.some((entry) => !bindingKeyShown(entry.key) || !claimValid(entry.key, entry.claim))) {
        problems.add('exemption-disagrees');
      }
      const listed = answer.sources.map((entry) => entry.source);
      if (new Set(listed).size !== listed.length || !sameSet(listed, stored.sourcesAtAnswer)
        || answer.sources.some((entry) => (entry.bought || entry.sold) !== (entry.accounts !== null))) {
        problems.add('sources-incomplete');
      }
    }
    const accountKey = (account: { accountId: string; source: MetalsSource; retired: boolean }) =>
      `${account.accountId}\u0000${account.source}\u0000${account.retired}`;
    if (!sameSet(stored.importedAccountsAtAnswer.map(accountKey), input.importedAccounts.map(accountKey))) problems.add('accounts-changed');
    if (!sameSet(stored.sourcesAtAnswer, input.sources)) problems.add('sources-changed');
    if (bindings.some((binding) => !binding.current)) problems.add('evidence-changed');
  }
  const contradicted = [...problems].some((problem) => !STALENESS.has(problem));
  const state: MetalsRosterState['state'] = !input.roster.installed ? 'not-installed' : stored === null ? 'unanswered'
    : contradicted ? 'contradicted' : problems.size > 0 ? 'stale' : 'current';
  const roster: MetalsRosterState = {
    state, asking: input.roster.asking, decidedAt: stored?.decidedAt ?? null, acquisitionStart: acqStart,
    problems: PROBLEMS.filter((problem) => problems.has(problem)),
    bindings: bindings.map((binding): MetalsRosterBindingState => ({
      key: binding.key, claim: binding.claim, rows: binding.rows, state: binding.current ? 'current' : 'stale',
    })).sort((a, b) => compareText(a.key, b.key) || compareText(a.claim, b.claim)),
  };
  // An exemption applies only while its binding and the roster are current (§6.5).
  const applies = (key: string, claim: MetalsRosterClaim) => state === 'current' && bound(key, claim, true) && claimValid(key, claim);
  const exemptionOf = (key: string, claims: readonly MetalsRosterClaim[]): MetalsGapExemption =>
    (claims.some((claim) => bound(key, claim, false)) ? 'stale' : 'none');

  // The card-row trigger accounting (C6): each gap's row ids, the scopes carrying it, and whether an exemption removed it.
  const rowsOf = new Map<string, string[]>();
  const present = new Map<string, Set<string>>();
  const removed = new Set<string>();
  const groups = (keep: (row: MetalsCardCaptureRow) => boolean) => {
    const found = new Map<string, string[]>();
    for (const row of counted) if (keep(row)) found.set(row.group, [...(found.get(row.group) ?? []), row.rowId]);
    return [...found.entries()].sort(([a], [b]) => compareText(a, b));
  };
  const dealerGroups = groups((row) => row.scope === 'gold-only' && (row.group.startsWith('dealer:') || row.group.startsWith('merchant:')));
  const processorGroups = groups((row) => row.group.startsWith('unresolved:'));
  const mixedGroups = groups((row) => row.scope === 'mixed-online');
  const sourceRows = (source: MetalsSource) => counted.filter((row) => row.source === source).map((row) => row.rowId);

  const scopeGaps = (name: string, need: MetalsCoverageNeed): MetalsCoverageGap[] => {
    const gaps: MetalsCoverageGap[] = [];
    // Registers a card-row trigger in this scope; false when an applying exemption removed it here.
    const card = (id: string, rowIds: string[], exempt: boolean) => {
      rowsOf.set(id, rowIds);
      if (exempt) {
        removed.add(id);
        return false;
      }
      present.set(id, (present.get(id) ?? new Set<string>()).add(name));
      return true;
    };
    const windowed = new Set<MetalsSource>();
    for (const side of SIDES) {
      const range = side === 'buy' ? need.buy : need.sell;
      if (range === null) continue;
      for (const source of METALS_SOURCES) {
        if (!usedFor(side, source)) continue;
        for (const account of windowAccountsOf(source)) {
          for (const kind of KINDS[side][source]) {
            const { covered, missing } = metalsCoverageOf(input.coverage, { accountId: account.accountId, kind, from: range.from, to: range.to });
            if (missing.length === 0) continue;
            gaps.push({ id: `${account.accountId}|${kind}`, variant: 'imported-window', account: refOf(account), kind, need: { from: range.from, to: range.to },
              covered, missing });
            windowed.add(source);
          }
        }
      }
    }
    for (const source of METALS_SOURCES) {
      const rows = sourceRows(source);
      const key = `source:${source}`;
      const noMetal = applies(key, 'no-metal-purchases');
      const entry = entryOf(source);
      const notImported = entry !== null && entry.accounts !== null && entry.accounts !== 'all-imported' ? entry.accounts.notImported : null;
      if (notImported !== null || importedOf(source).length === 0) {
        const triggers: MetalsGapTrigger[] = [];
        if (decidedAt !== null && (rosterSays('buy', source) || rosterSays('sell', source))) triggers.push({ by: 'roster', decidedAt });
        const records = recordsOn('buy', source) + recordsOn('sell', source);
        if (records > 0) triggers.push({ by: 'admitted-records', records });
        const carded = rows.length > 0 && card(`missing-account|${source}`, rows, noMetal);
        if (carded) triggers.push({ by: 'card-rows', rows: rows.length });
        if (triggers.length > 0) {
          gaps.push({ id: `missing-account|${source}`, variant: 'missing-account', source, imported: importedOf(source).length, missing: notImported,
            triggers, exemption: carded ? exemptionOf(key, ['no-metal-purchases']) : 'none' });
        }
      }
      for (const side of SIDES) {
        if (KINDS[side][source].length > 0) continue;
        const triggers: MetalsGapTrigger[] = [];
        if (decidedAt !== null && rosterSays(side, source)) triggers.push({ by: 'roster', decidedAt });
        const records = recordsOn(side, source);
        if (records > 0) triggers.push({ by: 'admitted-records', records });
        const carded = side === 'buy' && rows.length > 0 && card(`missing-kind|${source}|${side}`, rows, noMetal);
        if (carded) triggers.push({ by: 'card-rows', rows: rows.length });
        if (triggers.length > 0) {
          gaps.push({ id: `missing-kind|${source}|${side}`, variant: 'missing-kind', source, side, accounts: importedOf(source).map(refOf), triggers,
            exemption: carded ? exemptionOf(key, ['no-metal-purchases']) : 'none' });
        }
      }
    }
    for (const [group, rowIds] of dealerGroups) {
      const key = `group:${group}`;
      if (!card(`dealer|${group}`, rowIds, applies(key, 'no-metal-purchases'))) continue;
      gaps.push({ id: `dealer|${group}`, variant: 'unsupported-dealer', group, label: group.slice(group.indexOf(':') + 1), rows: rowIds.length,
        exemption: exemptionOf(key, ['no-metal-purchases']) });
    }
    for (const [group, rowIds] of processorGroups) {
      const key = `group:${group}`;
      const id = `alias|${group.slice('unresolved:'.length)}`;
      if (!card(id, rowIds, applies(key, 'no-metal-purchases'))) continue;
      gaps.push({ id, variant: 'alias-unresolved', group, rows: rowIds.length, exemption: exemptionOf(key, ['no-metal-purchases']) });
    }
    for (const [group, rowIds] of mixedGroups) {
      const source = sourceOfKey(`source:${group}`);
      if (source === null) continue;
      const key = `source:${source}`;
      // R3: only while every window the source's imported accounts need in this scope is complete.
      const exempt = (applies(key, 'accounts-complete') || applies(key, 'no-metal-purchases')) && !windowed.has(source);
      if (!card(`unexplained|${group}`, rowIds, exempt)) continue;
      gaps.push({ id: `unexplained|${group}`, variant: 'unexplained-charges', group, source, rows: rowIds.length,
        exemption: exemptionOf(key, ['accounts-complete', 'no-metal-purchases']) });
    }
    if (answer !== null && decidedAt !== null && answer.elsewhere.places > 0) {
      gaps.push({ id: 'missing-source|elsewhere', variant: 'missing-source', places: answer.elsewhere.places, decidedAt });
    }
    if (answer !== null && decidedAt !== null && answer.otherWays) gaps.push({ id: 'other-acquisition', variant: 'other-acquisition', decidedAt });
    if (state !== 'current') gaps.push({ id: 'roster', variant: 'roster', state, problems: [...roster.problems], rows: rosterRows.length });
    if (acqStart === null) gaps.push({ id: 'prefix', variant: 'unproven-prefix' });
    const unique = new Map<string, MetalsCoverageGap>();
    for (const gap of gaps) if (!unique.has(gap.id)) unique.set(gap.id, gap);
    return [...unique.values()].sort((a, b) => compareText(a.id, b.id));
  };

  // Scopes (§6.3): a side's need exists when a source used on it has kinds of it.
  const buyNeeded = METALS_SOURCES.some((source) => usedFor('buy', source) && KINDS.buy[source].length > 0);
  const sellNeeded = METALS_SOURCES.some((source) => usedFor('sell', source) && KINDS.sell[source].length > 0);
  const needThrough = (buyTo: string): MetalsCoverageNeed => ({
    buy: buyNeeded ? { from: acqStart, to: buyTo } : null,
    sell: sellNeeded ? { from: acqStart, to: input.asOf } : null,
  });
  const scopeOf = (name: string, need: MetalsCoverageNeed): MetalsCoverageScope => {
    if (capture === null) return { state: 'unavailable', need: null, gaps: [{ id: 'card-check', variant: 'card-check-unavailable' }] };
    const gaps = scopeGaps(name, need);
    return { state: gaps.length === 0 ? 'complete' : 'incomplete', need, gaps };
  };
  const metalsOf = (list: ReadonlyArray<Metal | null>) => [...new Set(list.filter((metal): metal is Metal => metal !== null))].sort(compareText);
  const recorded = metalsOf([...input.records.buys.map((record) => record.metal), ...input.records.sales.map((record) => record.metal)]);
  const sold = metalsOf(input.records.sales.filter((record) => record.included).map((record) => record.metal));
  const asOfScope = scopeOf('asOf', needThrough(input.asOf));
  // §8.2: when the card check fails, every scope and total is unavailable and carries `card-check`, no-sales ones too.
  const sales: MetalsSalesScope[] = recorded.map((metal): MetalsSalesScope => {
    if (capture === null) return { metal, state: 'unavailable', need: null, gaps: [{ id: 'card-check', variant: 'card-check-unavailable' }] };
    if (!sold.includes(metal)) return { metal, state: 'no-sales', need: null, gaps: [] };
    const last = input.records.sales.filter((record) => record.included && record.metal === metal)
      .reduce((latest, record) => (record.agreedDay > latest ? record.agreedDay : latest), '');
    const scope = scopeOf(`sales:${metal}`, needThrough(last));
    return { metal, state: scope.state, need: scope.need, gaps: scope.gaps };
  });
  const realized: MetalsCoverageProof['totals']['realized']['state'] = capture === null ? 'unavailable' : sold.length === 0 ? 'no-sales'
    : sales.every((scope) => scope.state === 'complete' || scope.state === 'no-sales') ? 'complete' : 'incomplete';

  // Card history (C7): a limit, never a gap, from one computation; the need is always dated.
  const recordDays = [...input.records.buys.map((record) => record.date), ...input.records.sales.map((record) => record.agreedDay)].sort(compareText);
  const historyFrom = acqStart ?? (recordDays.length > 0 ? recordDays[0] : input.asOf);
  const cardHistory = input.cardHistory.map((account) => ({
    accountId: account.accountId,
    unsynced: metalsRangeCoverage(account.covered, { from: historyFrom, to: input.asOf }).missing
      .map((range) => ({ from: range.from ?? historyFrom, to: range.to })),
  })).filter((account) => account.unsynced.length > 0).sort((a, b) => compareText(a.accountId, b.accountId));
  const limits: MetalsCoverageLimit[] = cardHistory.length > 0 ? [...LIMITS, 'card-history'] : [...LIMITS];

  // The catalog (C6): every citation from the trigger accounting above, never a second predicate.
  const entries = new Map<string, MetalsCardCheckGap>();
  const cites = new Map<string, Set<string>>(open.map((row): [string, Set<string>] => [row.rowId, new Set<string>()]));
  const cite = (rowIds: readonly string[], entry: MetalsCardCheckGap) => {
    if (rowIds.length === 0) return;
    entries.set(entry.id, entry);
    for (const rowId of rowIds) cites.get(rowId)?.add(entry.id);
  };
  for (const [id, rowIds] of rowsOf) {
    const scopes = [...(present.get(id) ?? [])].sort(compareText);
    if (scopes.length > 0) cite(rowIds, { id, kind: 'financial', scopes, reason: null });
    if (removed.has(id)) cite(rowIds, { id: EXEMPTED, kind: 'diagnostic', scopes: [], reason: 'exempted' });
  }
  const named: Array<{ name: string; gaps: readonly MetalsCoverageGap[] }> = [
    { name: 'asOf', gaps: asOfScope.gaps }, ...sales.map((scope) => ({ name: `sales:${scope.metal}`, gaps: scope.gaps })),
  ];
  const rosterScopes = named.filter((scope) => scope.gaps.some((gap) => gap.id === 'roster')).map((scope) => scope.name).sort(compareText);
  if (rosterScopes.length > 0) cite(rosterRows, { id: 'roster', kind: 'financial', scopes: rosterScopes, reason: null });
  cite(mixedBefore, { id: BEFORE_START, kind: 'diagnostic', scopes: [], reason: 'before-acquisition-start' });
  cite(exemptBefore, { id: EXEMPTED, kind: 'diagnostic', scopes: [], reason: 'exempted' });

  return {
    proof: {
      rule: METALS_COVERAGE_PROOF_RULE, snapshot: input.snapshot, asOf: input.asOf, roster, asOfScope, sales,
      totals: {
        realized: { metals: sold, state: realized },
        estimate: { metals: recorded, state: asOfScope.state },
        metalUnknown: { lots: input.records.metalUnknown.lots, saleLines: input.records.metalUnknown.saleLines },
      },
      limits,
    },
    catalog: {
      gaps: [...entries.values()].sort((a, b) => compareText(a.id, b.id)),
      rowGaps: new Map([...cites.entries()].map(([rowId, ids]): [string, string[]] => [rowId, [...ids].sort(compareText)])),
      cardHistory,
    },
  };
}
