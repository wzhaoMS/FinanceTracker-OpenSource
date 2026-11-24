// Holdr Card Sync: one sync of the American Express cards on this page. A classic script (content scripts cannot import
// modules) that defines globalThis.HoldrAmexSync for the panel (amex-panel.js) and the tests. It talks to the extension
// worker (`sw`, and through it the local receiver) and to the page helper (`rpc`, amex-page.js); it never writes anything
// on the bank's site.
(() => {
  'use strict';
  const STOP_TEXT = {
    'session-expired': 'American Express ended the session: sign in again, then Sync',
    'rate-limited': 'American Express asked to slow down: try again later',
    forbidden: 'American Express refused the request: try again later',
    off: 'Stopped: switched off',
  };
  class Stop extends Error {}

  const stopIf = (result) => {
    if (result && result.stopped) throw new Stop(STOP_TEXT[result.stopped.reason] || 'American Express stopped the sync');
  };
  const sameCard = (result, sourceId) => {
    if (!result || result.sourceId !== sourceId) throw new Stop('The page changed during the sync: reload it, then Sync again');
  };
  const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

  /** One line per card for the panel. */
  function describeResult(result) {
    const name = result.label || `··${result.last5}`;
    switch (result.outcome) {
      case 'saved': {
        const done = result.done || {};
        let line = `${name}: saved ${plural(done.rows || 0, 'row', 'rows')}`;
        if (done.preview) line += `; Holdr preview: ${done.preview.newCount} new, ${done.preview.duplicateCount} already imported`;
        else if (done.match === 'none') line += '; new card: create its account in the import dialog';
        else if (done.match === 'ambiguous') line += '; choose its card account in the import dialog';
        return line;
      }
      case 'already-imported': return `${name}: everything is already in Holdr`;
      case 'no-activity': return `${name}: no transactions in the statements fetched`;
      case 'up-to-date': return `${name}: up to date`;
      case 'shared-ending': return `${name}: not synced (another card here has the same ending)`;
      case 'identity-unclear': return `${name}: not synced (the page does not identify this card clearly)`;
      case 'no-statement-dates': return `${name}: statement dates unavailable; try again later`;
      case 'export-unreadable': return `${name}: a statement export could not be read; nothing was saved for this card`;
      default: return `${name}: ${result.outcome}`;
    }
  }

  function summarize(results) {
    const saved = results.filter((result) => result.outcome === 'saved');
    const skipped = results.filter((result) => !['saved', 'already-imported', 'no-activity', 'up-to-date'].includes(result.outcome));
    const rows = saved.reduce((sum, result) => sum + ((result.done && result.done.rows) || 0), 0);
    let text = saved.length
      ? `Saved ${plural(saved.length, 'file', 'files')} (${plural(rows, 'row', 'rows')}) for import. In Holdr: Spending, Import redacted JSON.`
      : 'Nothing new to save.';
    if (skipped.length) text += ` ${plural(skipped.length, 'card was', 'cards were')} not synced (see the list).`;
    return text;
  }

  /**
   * `sw(op, data)` resolves with the worker's result or rejects; `rpc(fn, ...args)` calls the page helper; `checkpoint()`
   * throws a Stop when the owner switched off; `ui.progress(text)` and `ui.cardDone(line)` show progress.
   */
  async function runSync({ sw, rpc, ui = {}, checkpoint = () => {}, newLease = () => crypto.randomUUID() }) {
    const progress = (text) => { if (ui.progress) ui.progress(text); };
    const lease = newLease();
    let leased = false;
    const results = [];
    const record = (result) => {
      results.push(result);
      if (ui.cardDone) ui.cardDone(describeResult(result));
    };
    try {
      const claim = await sw('claim', { lease });
      leased = claim.ok === true;
      checkpoint();
      if (!leased) throw new Stop('Another sync is running: try again in a minute');
      progress('Finding your cards…');
      const config = await sw('config');
      checkpoint();
      const found = await rpc('loadAccounts', config.salt);
      checkpoint();
      stopIf(found);
      const pageCards = ((found && found.accounts) || []).filter((card) => !card.supplementary && /^\d{5}$/.test(card.last5 || ''));
      if (!found || !found.ok || pageCards.length === 0) {
        throw new Stop('No cards found on this page: open your American Express account overview, then Sync');
      }
      const usable = pageCards.filter((card) => card.sourceId && !card.conflict && !card.sharedEnding);
      const listed = usable.length
        ? await sw('cards', { lease, cards: usable.map((card) => ({ sourceId: card.sourceId, last5: card.last5, product: card.product || null })) })
        : { cards: [], holdr: null };
      checkpoint();
      const byId = new Map(listed.cards.map((card) => [card.sourceId, card]));
      for (const pageCard of pageCards) {
        checkpoint();
        const card = pageCard.sourceId ? byId.get(pageCard.sourceId) : undefined;
        if (!card) {
          record({ last5: pageCard.last5, outcome: pageCard.sharedEnding ? 'shared-ending' : 'identity-unclear' });
          continue;
        }
        const base = { last5: card.last5, label: card.label };
        if (card.sharedEnding) {
          record({ ...base, outcome: 'shared-ending' });
          continue;
        }
        const identity = { sourceId: card.sourceId, last5: card.last5 };
        progress(`${card.label}: statement dates…`);
        const dates = await rpc('periods', card.sourceId);
        checkpoint();
        stopIf(dates);
        sameCard(dates, card.sourceId);
        if (!dates.ok) {
          record({ ...base, outcome: 'no-statement-dates' });
          continue;
        }
        const plan = await sw('plan', { lease, card: identity, periods: dates.periods.map((period) => ({ start: period.start || null, end: period.end })) });
        checkpoint();
        if (plan.fetch.length === 0) {
          record({ ...base, outcome: 'up-to-date' });
          continue;
        }
        let unreadable = false;
        for (let index = 0; index < plan.fetch.length; index += 1) {
          const period = plan.fetch[index];
          checkpoint();
          progress(`${card.label}: ${period.open ? 'current period' : `statement ${index + 1} of ${plan.fetch.length}`}…`);
          const renewed = await sw('claim', { lease });
          checkpoint();
          if (renewed.ok !== true) throw new Stop('Another sync took over: try again in a minute');
          const exported = await rpc('csv', card.sourceId, { end: period.end });
          checkpoint();
          stopIf(exported);
          sameCard(exported, card.sourceId);
          if (!exported.looksCsv && !exported.empty) {
            unreadable = true;
            break;
          }
          await sw('statement', { lease, card: identity, period: { start: period.start, end: period.end }, csv: exported.empty ? '' : exported.text });
          checkpoint();
        }
        if (unreadable) {
          await sw('discard', { lease, card: identity });
          record({ ...base, outcome: 'export-unreadable' });
          continue;
        }
        progress(`${card.label}: converting…`);
        const done = await sw('finish', { lease, card: identity });
        checkpoint();
        record({ ...base, outcome: done.alreadyImported ? 'already-imported' : done.empty ? 'no-activity' : 'saved', done });
      }
      return { results, holdr: listed.holdr, summary: summarize(results) };
    } finally {
      if (leased) {
        try { await sw('release', { lease }); } catch (_) { /* the lease expires on its own */ }
      }
    }
  }

  globalThis.HoldrAmexSync = Object.freeze({ runSync, describeResult, summarize, Stop, STOP_TEXT });
})();
