import {
  fidelityInvestingDigest, validateFidelityActivity, validateFidelityInvestingInput,
  type FidelityActivity, type FidelityInvestingCapture, type FidelityTransportAudit,
} from '../../apps/api/src/services/fidelityInvestingSync.js';
import { HoldrRefusal } from '../../apps/api/src/services/dbErrors.js';

export interface FidelityTransportEnvelope {
  jobId: string;
  capture: FidelityInvestingCapture;
  heldSources: { sourceId: string; last4: string; reason: 'unsupported-fidelity-holding' }[];
  heldActivity: { sourceId: string; activity: FidelityActivity }[];
  cancelled: number;
  boundaryRows: number;
}

function invalid(): never { throw new HoldrRefusal('invalid fidelity investing transport'); }
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== keys.sort().join('|')) invalid();
}

/** jobId hashes the canonical full envelope except jobId itself (avoids self-reference). */
export function validateFidelityTransport(value: unknown, policy: unknown): FidelityTransportEnvelope {
  exact(value, ['jobId', 'capture', 'heldSources', 'heldActivity', 'cancelled', 'boundaryRows']);
  validateFidelityInvestingInput(value.capture, policy);
  if (typeof value.jobId !== 'string' || !/^[a-f0-9]{64}$/.test(value.jobId)
    || !Array.isArray(value.heldSources) || !Array.isArray(value.heldActivity)
    || typeof value.cancelled !== 'number' || !Number.isSafeInteger(value.cancelled) || value.cancelled < 0
    || typeof value.boundaryRows !== 'number' || !Number.isSafeInteger(value.boundaryRows) || value.boundaryRows < 0) invalid();
  const sources = new Set<string>();
  const heldSources: FidelityTransportEnvelope['heldSources'] = [];
  for (const source of value.heldSources) {
    exact(source, ['sourceId', 'last4', 'reason']);
    if (typeof source.sourceId !== 'string' || !/^fidelity-[a-f0-9]{64}$/.test(source.sourceId)
      || typeof source.last4 !== 'string' || !/^\d{4}$/.test(source.last4)
      || source.reason !== 'unsupported-fidelity-holding' || sources.has(source.sourceId)) invalid();
    sources.add(source.sourceId);
    heldSources.push({ sourceId: source.sourceId, last4: source.last4, reason: source.reason });
  }
  const capture = value.capture as FidelityInvestingCapture;
  if (capture.accounts.length === 0 && heldSources.length === 0) invalid();
  if (capture.accounts.some(a => sources.has(a.sourceId))) invalid();
  const keys = new Set<string>();
  const heldActivity: FidelityTransportEnvelope['heldActivity'] = [];
  for (const held of value.heldActivity) {
    exact(held, ['sourceId', 'activity']);
    if (typeof held.sourceId !== 'string' || !sources.has(held.sourceId)) invalid();
    validateFidelityActivity(held.activity, '0001-01-01', new Date(capture.capturedAt).toISOString().slice(0, 10));
    const activity = held.activity as FidelityActivity;
    const key = `${held.sourceId}|${activity.key}`;
    if (keys.has(key)) invalid();
    keys.add(key);
    heldActivity.push({ sourceId: held.sourceId, activity });
  }
  const { jobId, ...body } = value;
  if (fidelityInvestingDigest(body) !== jobId) invalid();
  return { jobId: value.jobId, capture, heldSources, heldActivity, cancelled: value.cancelled, boundaryRows: value.boundaryRows };
}

export function fidelityTransportAudit(envelope: FidelityTransportEnvelope): FidelityTransportAudit {
  return {
    jobId: envelope.jobId, heldSources: envelope.heldSources.length, heldActivity: envelope.heldActivity.length,
    cancelled: envelope.cancelled, boundaryRows: envelope.boundaryRows,
  };
}
