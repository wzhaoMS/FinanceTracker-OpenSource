import { Router } from 'express';
import { createVerifiedRouter } from '../ingress/expressIdentity.js';
import type { CashEventInput, CashEventType } from '@finance-tracker/shared';

import type { SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { computeCashEventFingerprint, type CashEventCandidate } from '../services/cashEvents.js';
import { isDatabaseFailure } from '../services/dbErrors.js';

export function createCashEventsRouter(repo: SqliteStateRepo): Router {
  const router = createVerifiedRouter();

  router.get('/cash-events', (_req, res) => {
    return res.json({ cashEvents: repo.listAllCashEvents() });
  });

  router.post('/accounts/:id/cash-events', (req, res, next) => {
    const account = repo.getAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'account not found' });
    const confirmedLast4 = req.get('x-confirm-account-last4')?.trim();
    if (!confirmedLast4 || !/^\d{4}$/.test(confirmedLast4)) {
      return res.status(400).json({ error: 'X-Confirm-Account-Last4 must contain four digits' });
    }
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'body must be an object' });
    }
    const body = req.body as Record<string, unknown>;
    if (body.accountLast4 !== confirmedLast4) {
      return res.status(400).json({ error: 'confirmed account last four does not match the cash event' });
    }
    const configuredLast4 = accountLast4(account.accountNumber);
    if (!configuredLast4) {
      return res.status(409).json({ error: 'selected account must have an account number before broker cash events can be imported' });
    }
    if (configuredLast4 !== confirmedLast4) {
      return res.status(409).json({ error: 'selected account number does not match the cash event account' });
    }
    if (body.currency !== account.currency) {
      return res.status(409).json({ error: 'cash event currency does not match the selected account currency' });
    }
    const sourceOccurrence = body.sourceOccurrence;
    if (!Number.isInteger(sourceOccurrence) || (sourceOccurrence as number) < 0) {
      return res.status(400).json({ error: 'sourceOccurrence must be a non-negative integer' });
    }

    try {
      const candidate: CashEventCandidate = {
        date: body.date as string,
        eventType: body.eventType as CashEventType,
        amount: body.amount as number,
        accountLast4: body.accountLast4 as string,
        description: body.description as string,
      };
      const expectedFingerprint = computeCashEventFingerprint(
        body.broker as string,
        candidate,
        sourceOccurrence as number,
      );
      if (body.sourceFingerprint !== expectedFingerprint) {
        return res.status(400).json({ error: 'source fingerprint does not match cash event fields and occurrence' });
      }
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'cash event fingerprint is invalid' });
    }

    const input: CashEventInput = {
      accountId: req.params.id,
      date: body.date as string,
      eventType: body.eventType as CashEventType,
      amount: body.amount as number,
      currency: body.currency as string,
      broker: body.broker as string,
      accountLast4: body.accountLast4 as string,
      description: body.description as string,
      sourceFingerprint: body.sourceFingerprint as string,
    };
    try {
      const result = repo.insertCashEvent(input);
      return res.status(result.inserted ? 201 : 200).json(result);
    } catch (error) {
      if (isDatabaseFailure(error)) return next(error);
      return res.status(400).json({ error: error instanceof Error ? error.message : 'cash event is invalid' });
    }
  });

  router.get('/accounts/:id/cash-events', (req, res, next) => {
    if (!repo.getAccount(req.params.id)) {
      return res.status(404).json({ error: 'account not found' });
    }
    const from = singleQuery(req.query.from);
    const to = singleQuery(req.query.to);
    try {
      return res.json({ cashEvents: repo.listCashEvents(req.params.id, from, to) });
    } catch (error) {
      if (isDatabaseFailure(error)) return next(error);
      return res.status(400).json({ error: error instanceof Error ? error.message : 'invalid date range' });
    }
  });

  router.delete('/cash-events/:id', (req, res) => {
    if (!repo.deleteCashEvent(req.params.id)) {
      return res.status(404).json({ error: 'cash event not found' });
    }
    return res.status(204).end();
  });

  router.get('/accounts/:id/cash-history', (req, res) => {
    if (!repo.getAccount(req.params.id)) {
      return res.status(404).json({ error: 'account not found' });
    }
    return res.json({ cashHistory: repo.listCashHistory(req.params.id) });
  });

  router.post('/accounts/:id/cash-history', (req, res, next) => {
    const account = repo.getAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'account not found' });
    const confirmation = confirmAccountLast4(account.accountNumber, req.get('x-confirm-account-last4'));
    if ('error' in confirmation) return res.status(confirmation.status).json({ error: confirmation.error });
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'body must be an object' });
    }
    const body = req.body as Record<string, unknown>;
    if (body.accountLast4 !== confirmation.last4) {
      return res.status(400).json({ error: 'confirmed account last four does not match the cash history' });
    }
    if (body.currency !== account.currency) {
      return res.status(409).json({ error: 'cash history currency does not match the selected account currency' });
    }
    if (!Array.isArray(body.rows)) {
      return res.status(400).json({ error: 'rows must be an array' });
    }
    try {
      const result = repo.importCashHistory({
        accountId: account.id,
        currency: body.currency as string,
        broker: body.broker as string,
        accountLast4: confirmation.last4,
        sourceHash: body.sourceHash as string,
        method: body.method as string,
        rows: body.rows as Array<{ date: string; cashBalance: number }>,
      });
      if (result.conflicts.length > 0) {
        return res.status(409).json({ error: 'cash history conflicts with stored balances', ...result });
      }
      return res.status(result.inserted > 0 ? 201 : 200).json(result);
    } catch (error) {
      if (isDatabaseFailure(error)) return next(error);
      return res.status(400).json({ error: error instanceof Error ? error.message : 'cash history is invalid' });
    }
  });

  router.delete('/accounts/:id/cash-history', (req, res) => {
    const account = repo.getAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'account not found' });
    const confirmation = confirmAccountLast4(account.accountNumber, req.get('x-confirm-account-last4'));
    if ('error' in confirmation) return res.status(confirmation.status).json({ error: confirmation.error });
    return res.json({ deleted: repo.deleteCashHistory(account.id) });
  });

  return router;
}

function confirmAccountLast4(
  accountNumber: string | undefined,
  header: string | undefined,
): { last4: string } | { status: number; error: string } {
  const confirmedLast4 = header?.trim();
  if (!confirmedLast4 || !/^\d{4}$/.test(confirmedLast4)) {
    return { status: 400, error: 'X-Confirm-Account-Last4 must contain four digits' };
  }
  const configuredLast4 = accountLast4(accountNumber);
  if (!configuredLast4) {
    return { status: 409, error: 'selected account must have an account number before broker cash history can be changed' };
  }
  if (configuredLast4 !== confirmedLast4) {
    return { status: 409, error: 'selected account number does not match the confirmed last four' };
  }
  return { last4: confirmedLast4 };
}

function accountLast4(accountNumber: string | undefined): string | null {
  const digits = accountNumber?.replace(/\D/g, '') ?? '';
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function singleQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}