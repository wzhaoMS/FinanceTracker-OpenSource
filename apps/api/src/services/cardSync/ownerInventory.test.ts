import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CardSyncScenario } from '../../testing/cardSyncScenario.js';
import { cardSyncRefusalCode } from './refusals.js';

let w: CardSyncScenario;
beforeEach(() => { w = new CardSyncScenario(); w.enable(); });
afterEach(() => w.close());

describe('complete bounded owner authorization inventory', () => {
  it('pages every live binding rather than treating actionable entries as closed history', () => {
    for (let i = 0; i < 51; i++) w.binding();
    const first = w.repo.getCardSyncOwnerState();
    expect(first.bindings).toHaveLength(50);
    expect(first.inventory.bindings.total).toBe(51);
    const next = first.inventory.bindings.next!;
    const page = w.repo.getCardSyncOwnerAuthorityPage({
      kind: 'bindings', afterRowId: next.afterRowId, expectedGeneration: next.generation,
    });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(51);
    expect(page.next).toBeNull();
    expect(new Set([...first.bindings, ...page.items].map((row) => 'bindingId' in row && row.bindingId)).size).toBe(51);
  });

  it('pins each continuation to the current authorization generation inside its read transaction', () => {
    const binding = w.binding();
    for (let i = 0; i < 51; i++) w.device([binding.bindingId]);
    const first = w.repo.getCardSyncOwnerState();
    const next = first.inventory.devices.next!;
    w.device([binding.bindingId]);
    let error: unknown;
    try {
      w.repo.getCardSyncOwnerAuthorityPage({ kind: 'devices', afterRowId: next.afterRowId, expectedGeneration: next.generation });
    } catch (caught) { error = caught; }
    expect(cardSyncRefusalCode(error)).toBe('page-stale');
  });

  it('binding device and consent pages share one ordering and never drop the fifty-first active grant', () => {
    const binding = w.binding();
    for (let i = 0; i < 51; i++) w.device([binding.bindingId]);
    const first = w.repo.getCardSyncOwnerBinding(binding.bindingId)!;
    expect(first.deviceIds).toHaveLength(50);
    expect(first.autoSync.devices).toHaveLength(50);
    expect(first.deviceInventory).toMatchObject({ total: 51, active: 51 });
    const next = first.deviceInventory.next!;
    const page = w.repo.getCardSyncOwnerAuthorityPage({
      kind: 'binding-devices', bindingId: binding.bindingId, afterRowId: next.afterRowId, expectedGeneration: next.generation,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ status: 'active', enabled: false, consentedAt: null });
    expect(page.total).toBe(51);
    expect(page.active).toBe(51);
    expect(page.next).toBeNull();
  });
});
