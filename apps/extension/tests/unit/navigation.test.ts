/**
 * Route changes (common/navigation.ts): the MAIN observer and the ISOLATED
 * collector count them from the same Navigation API dispatch with the same
 * code, so a MAIN batch made under one count is taken only under that count.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeOf, watchRouteChanges } from '../../src/common/navigation.js';

class FakeNavigation extends EventTarget {
  currentEntry: { url: string | null } | null = { url: 'http://citi.e3.test/accounts' };

  /** The browser's dispatch after the current entry changed (pushState, replaceState, a traversal). */
  change(to: string | null): void {
    const from = this.currentEntry;
    this.currentEntry = { url: to };
    const event = new Event('currententrychange');
    Object.defineProperty(event, 'from', { value: from });
    this.dispatchEvent(event);
  }
}

test('both worlds count the same route changes: a change of path or query counts, a hash or state-only change does not', () => {
  const navigation = new FakeNavigation();
  const win = { navigation } as unknown as Window;
  const counts = { main: 0, isolated: 0 };
  assert.equal(watchRouteChanges(win, EventTarget.prototype.addEventListener, () => { counts.main += 1; }), true);
  assert.equal(watchRouteChanges(win, EventTarget.prototype.addEventListener, () => { counts.isolated += 1; }), true);
  navigation.change('http://citi.e3.test/accounts/other');
  navigation.change('http://citi.e3.test/accounts/other#statement');
  navigation.change('http://citi.e3.test/accounts/other?tab=2');
  navigation.change('http://citi.e3.test/accounts/other?tab=2');
  // There and back again is two changes, never zero.
  navigation.change('http://citi.e3.test/accounts');
  navigation.change('http://citi.e3.test/accounts/other?tab=2');
  assert.deepEqual(counts, { main: 4, isolated: 4 });
  assert.equal(watchRouteChanges({} as Window, EventTarget.prototype.addEventListener, () => undefined), false);
  assert.equal(routeOf('http://citi.e3.test/a?b=1#c'), '/a?b=1');
  assert.equal(routeOf('not a url'), null);
  assert.equal(routeOf(null), null);
});
