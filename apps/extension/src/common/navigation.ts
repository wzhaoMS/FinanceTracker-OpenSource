/**
 * Same-document navigations that change the page's route (path or query),
 * from the Navigation API's `currententrychange` event (Chrome 102; the
 * manifest requires 121). The browser dispatches it once, right after the
 * current entry changed (pushState, replaceState, a same-document traversal,
 * an intercepted navigation), to every listener of the page, the MAIN
 * observer's and the ISOLATED collector's included, in that one dispatch and
 * before any page listener (both register at document_start). Both count
 * route changes with this same code, so their counts agree at every moment
 * page code can run: a request the page makes carries the count it was made
 * under, and the collector takes an answer only under the same count.
 */

interface NavigationLike extends EventTarget {
  readonly currentEntry?: { readonly url: string | null } | null;
}

/** Path and query of a URL (the route); null when there is none. */
export function routeOf(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

/**
 * Calls `onRouteChange` for every current-entry change that changes the
 * route (a hash or state-only change does not). `addListener` is the
 * caller's own copy of `EventTarget.prototype.addEventListener`. Returns
 * false when the page has no Navigation API.
 */
export function watchRouteChanges(
  win: Window,
  addListener: typeof EventTarget.prototype.addEventListener,
  onRouteChange: () => void,
): boolean {
  const navigation = (win as unknown as { navigation?: NavigationLike }).navigation;
  if (!navigation) return false;
  addListener.call(navigation, 'currententrychange', (event: Event) => {
    const from = (event as Event & { readonly from?: { readonly url?: string | null } | null }).from?.url;
    if (routeOf(from) !== routeOf(navigation.currentEntry?.url)) onRouteChange();
  });
  return true;
}
