import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BenefitPeriodView, BenefitView, CardBenefitsCardView } from '@finance-tracker/shared';

import type { BenefitGroup, BenefitGroupMember } from './benefitGroups';
import {
  cardUsageSnapshot,
  countedPeriods,
  groupNow,
  groupUsage,
  historyIndex,
  memberKey,
  periodsUsage,
  rankGroups,
  rankCardBenefits,
  rankMembers,
  rankedTiers,
  rankingFingerprint,
  usageSnapshot,
  usageWindow,
  type GroupUsage,
} from './benefitUsage';

/** Synthetic values only: made-up cards, benefits and periods. */

const TODAY = '2026-10-23';
const WINDOW = usageWindow(2026, TODAY)!;

function period(start: string, end: string, usedMinor: number | null, patch: Partial<BenefitPeriodView> = {}): BenefitPeriodView {
  return {
    start, end, label: start, state: end < TODAY ? 'past' : start <= TODAY ? 'current' : 'future', active: true, availableMinor: 1000,
    usedMinor, source: 'derived', derivedMinor: usedMinor ?? 0, matches: [], mark: null, issuer: null, ...patch,
  };
}

/** Monthly periods of 2026 (Jan..Dec), each used as `used(month)` says (1-12); null = unknown. */
function monthly(used: (month: number) => number | null, year = 2026): BenefitPeriodView[] {
  return Array.from({ length: 12 }, (_, index) => {
    const month = String(index + 1).padStart(2, '0');
    const end = new Date(Date.UTC(year, index + 1, 0)).toISOString().slice(0, 10);
    return period(`${year}-${month}-01`, end, used(index + 1));
  });
}

function benefit(id: string, periods: BenefitPeriodView[], patch: Partial<BenefitView> = {}): BenefitView {
  return {
    id, name: id, kind: 'credit', unit: 'usd', cadence: { every: 'month', basis: 'calendar' }, cadenceLabel: 'Monthly', enrollment: false,
    tracking: 'statement-credit', verify: false, needsAnniversary: false, periods,
    current: (periods.find((entry) => entry.start <= TODAY && entry.end >= TODAY) as BenefitView['current']) ?? null,
    year: { capturedMinor: 0, availableMinor: 0, unknownPeriods: 0 }, inTotals: true, ...patch,
  };
}

const card = (id: string): CardBenefitsCardView => ({ cardAccountId: `card-acct-${id}` } as CardBenefitsCardView);
const member = (cardId: string, entry: BenefitView): BenefitGroupMember => ({ card: card(cardId), benefit: entry });
const group = (key: string, members: BenefitGroupMember[], kind: BenefitGroup['kind'] = 'credit'): BenefitGroup =>
  ({ key, kind, members } as unknown as BenefitGroup);
const NO_HISTORY = new Map<string, BenefitView>();

test('the window is the trailing 12 months for this year, the year itself for a past one, and none for a year to come', () => {
  assert.deepEqual(usageWindow(2026, '2026-10-23'), { from: '2025-10-24', to: '2026-10-23', trailing: true });
  assert.deepEqual(usageWindow(2025, '2026-10-23'), { from: '2025-01-01', to: '2025-12-31', trailing: false });
  assert.equal(usageWindow(2027, '2026-10-23'), null);
  // A leap day a year back has no same date: the window starts the day after Feb 28.
  assert.deepEqual(usageWindow(2028, '2028-02-29'), { from: '2027-03-01', to: '2028-02-29', trailing: true });
});

test('a monthly credit used in nine months ranks above an annual one used once, and unused extra cards dilute nothing', () => {
  const monthlyUsed = group('monthly', [member('a', benefit('monthly', monthly((month) => (month <= 9 ? 500 : 0))))]);
  const annualUsed = group('annual', [
    member('b', benefit('annual', [period('2026-01-01', '2026-12-31', 20900)])),
    // Three more cards with the annual credit and no use: still one card-period used, not a quarter.
    ...['c', 'd', 'e'].map((id) => member(id, benefit('annual', [period('2026-01-01', '2026-12-31', 0)]))),
  ]);
  const usage = new Map([monthlyUsed, annualUsed].map((entry) => [entry.key, groupUsage(entry, NO_HISTORY, WINDOW)]));
  assert.equal(usage.get('monthly')!.usedPeriods, 9);
  assert.equal(usage.get('annual')!.usedPeriods, 1);
  assert.deepEqual(rankGroups([annualUsed, monthlyUsed], usage).map(({ tier, groups }) => [tier, groups.map((entry) => entry.key)]),
    [['used', ['monthly', 'annual']]]);
});

test('used, unknown, unplaced and unused are told apart: unknown or unplaced is never called unused', () => {
  const mixed = group('mixed', [member('a', benefit('mixed', monthly((month) => (month === 3 ? 100 : month === 4 ? null : 0))))]);
  const unknown = group('unknown', [member('a', benefit('unknown', monthly((month) => (month <= 10 ? null : 0)), { tracking: 'manual' }))]);
  const zero = group('zero', [member('a', benefit('zero', monthly(() => 0)))]);
  const unplaced = group('unplaced', [member('a', benefit('unplaced', [], { needsAnniversary: true }))]);
  const window = group('window', [member('a', benefit('window', [period('2026-01-01', '2026-12-31', 0)]))], 'window');
  const groups = [zero, unplaced, window, unknown, mixed];
  const usage = new Map(groups.map((entry) => [entry.key, groupUsage(entry, NO_HISTORY, WINDOW)]));
  assert.deepEqual([...usage].map(([key, value]) => [key, value.tier]),
    [['zero', 'unused'], ['unplaced', 'unplaced'], ['window', 'occasional'], ['unknown', 'unknown'], ['mixed', 'used']]);
  // A used group keeps saying how much of it is unknown.
  assert.equal(usage.get('mixed')!.unknownPeriods, 1);
  assert.deepEqual(rankGroups(groups, usage).map(({ tier, groups: listed }) => [tier, listed.map((entry) => entry.key)]), [
    ['used', ['mixed']], ['unknown', ['unknown']], ['occasional', ['window']], ['unplaced', ['unplaced']], ['unused', ['zero']],
  ]);
});

test('future and inactive periods never count; today\'s period does', () => {
  // Nov and Dec are still to come; a month the benefit did not exist in is inactive.
  const periods = monthly((month) => (month === 10 ? 300 : month >= 11 ? 900 : 0)).map((entry) =>
    (entry.start === '2026-02-01' ? { ...entry, active: false, usedMinor: 700 } : entry));
  const counted = countedPeriods(benefit('x', periods), undefined, WINDOW);
  assert.deepEqual(counted.map((entry) => entry.start.slice(5, 7)), ['01', '03', '04', '05', '06', '07', '08', '09', '10']);
  assert.deepEqual(periodsUsage(counted), { usedPeriods: 1, unknownPeriods: 0, countedPeriods: 9, lastUsed: '2026-10-01' });
});

test('in January the year before still counts: last year\'s report fills the trailing window', () => {
  const today = '2027-01-05';
  const window = usageWindow(2027, today)!;
  const thisYear = benefit('dining', [period('2027-01-01', '2027-01-31', 0)]);
  const lastYear = benefit('dining', monthly((month) => (month >= 2 ? 1000 : 0)));
  const history = historyIndex([{ ...card('a'), benefits: [lastYear] } as CardBenefitsCardView]);
  const usage = groupUsage(group('dining', [member('a', thisYear)]), history, window);
  // Feb..Dec 2026 were used (Jan 2026, which the window still overlaps, was not).
  assert.equal(usage.tier, 'used');
  assert.equal(usage.usedPeriods, 11);
  assert.equal(usage.countedPeriods, 13);
  assert.equal(usage.lastUsed, '2026-12-01');
  // Without last year's report it would read as unused: the fallback the page says it used.
  assert.equal(groupUsage(group('dining', [member('a', thisYear)]), NO_HISTORY, window).tier, 'unused');
});

test('a cardmember year begun last year counts once, from this year\'s answer, though both years list it', () => {
  const spanning = period('2025-11-01', '2026-10-31', 1, { availableMinor: 1 });
  const thisYear = benefit('night', [period('2026-11-01', '2027-10-31', null, { state: 'future', availableMinor: 1 })], {
    unit: 'count', current: { ...spanning, daysLeft: 9, remainingMinor: 0, resetsSoon: false },
  });
  // Last year's report has the same period, still unknown then: this year's figure wins. The year before it ends a
  // few days into the window, so it counts too (unused).
  const lastYear = benefit('night', [period('2024-11-01', '2025-10-31', 0), { ...spanning, usedMinor: null }]);
  const counted = countedPeriods(thisYear, lastYear, WINDOW);
  assert.deepEqual(counted.map((entry) => [entry.start, entry.usedMinor]), [['2025-11-01', 1], ['2024-11-01', 0]]);
  // A certificate counts once, not by how many it gave.
  assert.equal(periodsUsage([{ start: '2025-11-01', usedMinor: 2 }]).usedPeriods, 1);
});

test('a past year ranks on its own periods only, never on today\'s', () => {
  const window = usageWindow(2025, TODAY)!;
  const past = benefit('x', monthly((month) => (month === 6 ? 100 : 0), 2025), {
    current: { ...period('2026-10-01', '2026-10-31', 900), daysLeft: 9, remainingMinor: 100, resetsSoon: false },
  });
  assert.deepEqual(periodsUsage(countedPeriods(past, undefined, window)), { usedPeriods: 1, unknownPeriods: 0, countedPeriods: 12, lastUsed: '2025-06-01' });
});

test('a tie goes to the latest use, then to the order the groups came in; ranking adds and drops nothing', () => {
  const early = group('early', [member('a', benefit('early', monthly((month) => (month <= 3 ? 100 : 0))))]);
  const late = group('late', [member('a', benefit('late', monthly((month) => (month >= 7 && month <= 9 ? 100 : 0))))]);
  const first = group('first', [member('a', benefit('first', monthly(() => 0)))]);
  const second = group('second', [member('a', benefit('second', monthly(() => 0)))]);
  const groups = [first, early, second, late];
  const usage = new Map<string, GroupUsage>(groups.map((entry) => [entry.key, groupUsage(entry, NO_HISTORY, WINDOW)]));
  const ranked = rankGroups(groups, usage);
  assert.deepEqual(ranked.map(({ tier, groups: listed }) => [tier, listed.map((entry) => entry.key)]),
    [['used', ['late', 'early']], ['unused', ['first', 'second']]]);
  // The same group objects, each once: figures, members and exclusions are untouched.
  const listed = ranked.flatMap((entry) => entry.groups);
  assert.equal(listed.length, groups.length);
  for (const entry of groups) assert.equal(listed.filter((other) => other === entry).length, 1);
});

test('a group\'s cards: the most used first, the others in their order', () => {
  const members = [
    member('a', benefit('x', monthly(() => 0))),
    member('b', benefit('x', monthly((month) => (month === 2 ? 100 : 0)))),
    member('c', benefit('x', monthly(() => 0))),
    member('d', benefit('x', monthly((month) => (month <= 4 ? 100 : 0)))),
  ];
  assert.deepEqual(rankMembers(members, NO_HISTORY, WINDOW).map((entry) => entry.card.cardAccountId),
    ['card-acct-d', 'card-acct-b', 'card-acct-a', 'card-acct-c']);
  assert.equal(memberKey(card('a'), { id: 'x' }), 'card-acct-a|x');
});

test('once every few years: the latest used first, then the soonest usable again, the never used last in their order', () => {
  const windowed = (key: string, entries: Array<{ lastUsed: string | null; nextEligible: string | null }>) =>
    group(key, entries.map((window, index) => member(`${key}${index}`, benefit(key, [], { window, inTotals: false }))), 'window');
  const never = windowed('never', [{ lastUsed: null, nextEligible: null }]);
  const old = windowed('old', [{ lastUsed: '2023-05-02', nextEligible: '2027-05-02' }]);
  const recent = windowed('recent', [{ lastUsed: null, nextEligible: null }, { lastUsed: '2025-03-09', nextEligible: '2029-03-09' }]);
  const sameDaySooner = windowed('sooner', [{ lastUsed: '2023-05-02', nextEligible: '2026-05-02' }]);
  const groups = [never, old, recent, sameDaySooner];
  const usage = new Map(groups.map((entry) => [entry.key, groupUsage(entry, NO_HISTORY, WINDOW)]));
  assert.deepEqual([usage.get('recent')!.lastUsed, usage.get('recent')!.nextEligible], ['2025-03-09', '2029-03-09']);
  assert.deepEqual(usage.get('never')!.nextEligible, null);
  assert.deepEqual(rankGroups(groups, usage).map(({ tier, groups: listed }) => [tier, listed.map((entry) => entry.key)]),
    [['occasional', ['recent', 'sooner', 'old', 'never']]]);
});

test('a folded group\'s line: what its cards have left now, and the soonest reset among them', () => {
  const current = (remainingMinor: number | null, daysLeft: number, active = true) =>
    ({ ...period('2026-10-01', '2026-10-31', 0, { active }), daysLeft, remainingMinor, resetsSoon: false });
  const left = group('left', [
    member('a', benefit('x', [], { current: current(1500, 9) })),
    member('b', benefit('x', [], { current: current(500, 70) })),
    // Used up, not known, not active or no period today: nothing to add, and not the soonest reset.
    member('c', benefit('x', [], { current: current(0, 2) })),
    member('d', benefit('x', [], { current: current(null, 3) })),
    member('e', benefit('x', [], { current: current(800, 1, false) })),
    member('f', benefit('x', [], { current: null })),
  ]);
  assert.deepEqual(groupNow(left), { leftMinor: 2000, daysLeft: 9 });
  assert.equal(groupNow(group('none', [member('a', benefit('x', [], { current: current(0, 4) }))])), null);
});

test('the order is set again when the cards or their placing change, never when a period is marked', () => {
  const placed = group('g', [member('a', benefit('x', monthly(() => 0)))]);
  const base = rankingFingerprint([placed], null, WINDOW);
  // A mark: another figure, the same groups, cards and placing.
  const marked = group('g', [member('a', benefit('x', monthly((month) => (month === 10 ? 900 : 0))))]);
  assert.equal(rankingFingerprint([marked], null, WINDOW), base);
  // An anniversary month still to set, another card, another window or last year's report: set again.
  assert.notEqual(rankingFingerprint([group('g', [member('a', benefit('x', [], { needsAnniversary: true }))])], null, WINDOW), base);
  assert.notEqual(rankingFingerprint([group('g', [...placed.members, member('b', benefit('x', monthly(() => 0)))])], null, WINDOW), base);
  assert.notEqual(rankingFingerprint([placed], null, usageWindow(2025, TODAY)!), base);
  const history = [{ ...card('a'), benefits: [benefit('x', monthly(() => 0, 2025))] } as CardBenefitsCardView];
  const withHistory = rankingFingerprint([placed], history, WINDOW);
  assert.notEqual(withHistory, base);
  // Last year's figures changing (a mark there) do not set it again; its placing does.
  const markedHistory = [{ ...card('a'), benefits: [benefit('x', monthly(() => 100, 2025))] } as CardBenefitsCardView];
  assert.equal(rankingFingerprint([placed], markedHistory, WINDOW), withHistory);
  const unplacedHistory = [{ ...card('a'), benefits: [benefit('x', [], { needsAnniversary: true })] } as CardBenefitsCardView];
  assert.notEqual(rankingFingerprint([placed], unplacedHistory, WINDOW), withHistory);
});

test('marking a period changes a group\'s figures, not where it is listed, until the order is set again', () => {
  const unknownBefore = group('manual', [
    member('a', benefit('manual', monthly(() => null), { tracking: 'manual' })),
    member('b', benefit('manual', monthly(() => null), { tracking: 'manual' })),
  ]);
  const used = group('used', [member('a', benefit('used', monthly((month) => (month === 1 ? 100 : 0))))]);
  const snapshot = usageSnapshot([used, unknownBefore], NO_HISTORY, WINDOW);
  // Card b's October is marked used: as of now the group is used, and b its most used card.
  const unknownAfter = group('manual', [
    unknownBefore.members[0],
    member('b', benefit('manual', monthly((month) => (month === 10 ? 1500 : null)), { tracking: 'manual' })),
  ]);
  const fresh = rankedTiers([used, unknownAfter], usageSnapshot([used, unknownAfter], NO_HISTORY, WINDOW), NO_HISTORY, WINDOW);
  assert.deepEqual(fresh.map(({ tier, groups }) => [tier, groups.map((entry) => entry.key)]), [['used', ['manual', 'used']]]);
  // With the snapshot taken before the mark: listed where it was, its cards in their order, its figures the new ones.
  const kept = rankedTiers([used, unknownAfter], snapshot, NO_HISTORY, WINDOW);
  assert.deepEqual(kept.map(({ tier, groups }) => [tier, groups.map((entry) => entry.key)]), [['used', ['used']], ['unknown', ['manual']]]);
  const manual = kept[1].groups[0];
  assert.deepEqual(manual.members.map((entry) => entry.card.cardAccountId), ['card-acct-a', 'card-acct-b']);
  assert.equal(manual.members[1].benefit, unknownAfter.members[1].benefit);
  // A group the snapshot has not seen is ranked by its use now.
  const added = group('added', [member('c', benefit('added', monthly(() => 0)))]);
  assert.deepEqual(rankedTiers([used, unknownAfter, added], snapshot, NO_HISTORY, WINDOW).map(({ tier, groups }) => [tier, groups.map((entry) => entry.key)]),
    [['used', ['used']], ['unknown', ['manual']], ['unused', ['added']]]);
});

test('By card: a card\'s benefits most used first, by tier, the rest in the card\'s own order', () => {
  const benefits = [
    benefit('never', monthly(() => 0)),
    benefit('once', monthly((month) => (month === 2 ? 100 : 0))),
    benefit('unmarked', monthly(() => null), { tracking: 'manual' }),
    benefit('often', monthly((month) => (month <= 4 ? 100 : 0))),
    benefit('fee', [], { inTotals: false, window: { lastUsed: null, nextEligible: null } }),
    benefit('never-too', monthly(() => 0)),
  ];
  const owner = { ...card('a'), benefits } as CardBenefitsCardView;
  const snapshot = cardUsageSnapshot([owner], NO_HISTORY, WINDOW);
  assert.equal(snapshot.size, benefits.length);
  const ranked = rankCardBenefits(owner, (entry) => snapshot.get(memberKey(owner, entry))!);
  assert.deepEqual(ranked.map((entry) => entry.id), ['often', 'once', 'unmarked', 'fee', 'never', 'never-too']);
  // The same benefits, each once.
  assert.equal(new Set(ranked).size, benefits.length);
});
