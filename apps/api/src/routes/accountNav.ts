import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import express, { Router, type Request } from 'express';
import { createVerifiedRouter } from '../ingress/expressIdentity.js';

import {
  extractFirstPageTextFromPdf,
  parseSchwabNavStatementText,
  type ParsedAccountNavStatement,
} from '../services/accountNavStatement.js';
import type { AccountNavObservationInput, SqliteStateRepo } from '../services/sqliteStateRepo.js';
import { isDatabaseFailure } from '../services/dbErrors.js';
import { asyncRoute } from '../asyncRoute.js';

export interface CreateAccountNavRouterOptions {
  state: Pick<
    SqliteStateRepo,
    'getAccount' | 'listAccounts' | 'insertAccountNavObservation' | 'listAccountNavHistory'
  >;
  extractFirstPageText?: (data: Uint8Array) => Promise<string>;
  previewSecret?: string | Buffer;
  now?: () => number;
}

interface ParsedPdf {
  statement: ParsedAccountNavStatement;
  documentHash: string;
  fileName?: string;
}

interface PdfRequest {
  data: Buffer;
  documentHash: string;
  fileName?: string;
}

interface PreviewTokenPayload {
  version: 1;
  documentHash: string;
  accountLast4: string;
  observedAt: string;
  expiresAt: number;
}

const pdfBody = express.raw({ type: 'application/pdf', limit: '10mb' });
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PREVIEW_TOKEN_TTL_MS = 15 * 60 * 1000;

export function createAccountNavRouter(options: CreateAccountNavRouterOptions): Router {
  const router = createVerifiedRouter();
  const extractText = options.extractFirstPageText ?? extractFirstPageTextFromPdf;
  const previewSecret = options.previewSecret ?? randomBytes(32);
  const now = options.now ?? Date.now;
  let activePdfParses = 0;
  const withPdfParseSlot = async <T>(work: () => Promise<T>): Promise<T> => {
    if (activePdfParses > 0) {
      throw new ImportRequestError(429, 'another NAV statement is already being parsed; wait and retry');
    }
    activePdfParses += 1;
    try {
      return await work();
    } finally {
      activePdfParses -= 1;
    }
  };

  router.post('/import/nav-statement/preview', pdfBody, asyncRoute(async (req, res, next) => {
    try {
      const parsed = await withPdfParseSlot(() => parsePdfRequest(req, extractText));
      const accountMatches = options.state.listAccounts()
        .filter((account) => accountLast4(account.accountNumber) === parsed.statement.accountLast4)
        .map(({ id, name, type }) => ({ id, name, type }));
      return res.json({
        statement: parsed.statement,
        source: {
          documentHash: parsed.documentHash,
          fileName: parsed.fileName,
          page: parsed.statement.sourcePage,
        },
        previewToken: signPreviewToken(parsed, previewSecret, now()),
        accountMatches,
        requiresExplicitAccountSelection: true,
      });
    } catch (error) {
      return sendImportError(res, error, next);
    }
  }));

  router.post('/accounts/:id/nav-history/import', pdfBody, asyncRoute(async (req, res, next) => {
    const account = options.state.getAccount(req.params.id);
    if (!account) {
      return res.status(404).json({ error: 'account not found' });
    }
    const previewToken = req.get('x-nav-preview-token')?.trim();
    if (!previewToken) {
      return res.status(400).json({ error: 'X-NAV-Preview-Token is required; preview the statement first' });
    }
    const confirmedLast4 = req.get('x-confirm-account-last4')?.trim();
    if (!confirmedLast4 || !/^\d{4}$/.test(confirmedLast4)) {
      return res.status(400).json({ error: 'X-Confirm-Account-Last4 must be the four digits shown in preview' });
    }

    try {
      const preview = verifyPreviewToken(previewToken, previewSecret, now());
      const pdf = readPdfRequest(req);
      if (preview.documentHash !== pdf.documentHash) {
        return res.status(409).json({ error: 'uploaded PDF does not match preview; preview the statement again' });
      }
      const parsed = await withPdfParseSlot(() => parsePdf(pdf, extractText));
      if (
        preview.accountLast4 !== parsed.statement.accountLast4
        || preview.observedAt !== parsed.statement.observedAt
      ) {
        return res.status(409).json({ error: 'parsed statement does not match preview; preview the statement again' });
      }
      if (confirmedLast4 !== parsed.statement.accountLast4) {
        return res.status(400).json({ error: 'confirmed account last four does not match the statement' });
      }
      const configuredLast4 = accountLast4(account.accountNumber);
      if (configuredLast4 && configuredLast4 !== parsed.statement.accountLast4) {
        return res.status(409).json({ error: 'selected account number does not match the statement account' });
      }

      const input: AccountNavObservationInput = {
        id: observationId(req.params.id, parsed.documentHash, parsed.statement.observedAt),
        accountId: req.params.id,
        ...parsed.statement,
        sourceDocumentHash: parsed.documentHash,
        sourceFileName: parsed.fileName,
      };
      const result = options.state.insertAccountNavObservation(input);
      return res.status(result.inserted ? 201 : 200).json(result);
    } catch (error) {
      return sendImportError(res, error, next);
    }
  }));

  router.get('/accounts/:id/nav-history', (req, res) => {
    if (!options.state.getAccount(req.params.id)) {
      return res.status(404).json({ error: 'account not found' });
    }
    const from = singleQuery(req.query.from);
    const to = singleQuery(req.query.to);
    if ((from && !isValidIsoDate(from)) || (to && !isValidIsoDate(to))) {
      return res.status(400).json({ error: 'from and to must use YYYY-MM-DD' });
    }
    if (from && to && from > to) {
      return res.status(400).json({ error: 'from must not be after to' });
    }
    return res.json({ navHistory: options.state.listAccountNavHistory(req.params.id, from, to) });
  });

  return router;
}

async function parsePdfRequest(
  req: Request,
  extractText: (data: Uint8Array) => Promise<string>,
): Promise<ParsedPdf> {
  return parsePdf(readPdfRequest(req), extractText);
}

function readPdfRequest(req: Request): PdfRequest {
  if (!req.is('application/pdf')) {
    throw new ImportRequestError(415, 'Content-Type must be application/pdf');
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    throw new ImportRequestError(400, 'PDF body is required');
  }
  if (req.body.subarray(0, 1024).indexOf('%PDF-') < 0) {
    throw new ImportRequestError(400, 'body is not a PDF document');
  }
  return {
    data: req.body,
    documentHash: createHash('sha256').update(req.body).digest('hex'),
    fileName: safeFileName(req.get('x-file-name')),
  };
}

async function parsePdf(
  pdf: PdfRequest,
  extractText: (data: Uint8Array) => Promise<string>,
): Promise<ParsedPdf> {
  const text = await extractText(pdf.data);
  return {
    statement: parseSchwabNavStatementText(text),
    documentHash: pdf.documentHash,
    fileName: pdf.fileName,
  };
}

function signPreviewToken(parsed: ParsedPdf, secret: string | Buffer, now: number): string {
  const payload: PreviewTokenPayload = {
    version: 1,
    documentHash: parsed.documentHash,
    accountLast4: parsed.statement.accountLast4,
    observedAt: parsed.statement.observedAt,
    expiresAt: now + PREVIEW_TOKEN_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyPreviewToken(token: string, secret: string | Buffer, now: number): PreviewTokenPayload {
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra || token.length > 2_048) {
    throw new ImportRequestError(400, 'invalid NAV preview token; preview the statement again');
  }
  const expected = createHmac('sha256', secret).update(encoded).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, 'base64url');
  } catch {
    throw new ImportRequestError(400, 'invalid NAV preview token; preview the statement again');
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new ImportRequestError(400, 'invalid NAV preview token; preview the statement again');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new ImportRequestError(400, 'invalid NAV preview token; preview the statement again');
  }
  if (!isPreviewTokenPayload(payload)) {
    throw new ImportRequestError(400, 'invalid NAV preview token; preview the statement again');
  }
  if (payload.expiresAt < now) {
    throw new ImportRequestError(409, 'NAV preview token expired; preview the statement again');
  }
  return payload;
}

function isPreviewTokenPayload(value: unknown): value is PreviewTokenPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<PreviewTokenPayload>;
  return payload.version === 1
    && typeof payload.documentHash === 'string'
    && /^[a-f0-9]{64}$/.test(payload.documentHash)
    && typeof payload.accountLast4 === 'string'
    && /^\d{4}$/.test(payload.accountLast4)
    && typeof payload.observedAt === 'string'
    && isValidIsoDate(payload.observedAt)
    && typeof payload.expiresAt === 'number'
    && Number.isFinite(payload.expiresAt);
}

function safeFileName(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const base = path.posix.basename(path.win32.basename(raw.trim())).slice(0, 255);
  return base || undefined;
}

function accountLast4(accountNumber: string | undefined): string | null {
  const digits = accountNumber?.replace(/\D/g, '') ?? '';
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function observationId(accountId: string, documentHash: string, observedAt: string): string {
  return `nav-${createHash('sha256')
    .update(`${accountId}\0${documentHash}\0${observedAt}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function singleQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

class ImportRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendImportError(res: express.Response, error: unknown, next: express.NextFunction) {
  // A database failure goes to the app's value-free error handler: its message can quote the database.
  if (isDatabaseFailure(error)) return next(error);
  if (error instanceof ImportRequestError) {
    return res.status(error.status).json({ error: error.message });
  }
  return res.status(422).json({
    error: error instanceof Error ? error.message : 'statement could not be parsed',
  });
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || year > 9999) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}