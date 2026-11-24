/**
 * The UI state model of the E8-M controls: how the owner API's state maps to
 * the plan §8 status list, per binding, and the warnings around expiry and
 * quota. Pure functions of the server's answer and a "now" taken from the
 * server's clock (its `generatedAt` plus the time since the answer arrived),
 * so an off browser clock cannot hide an expiry.
 */
import type { AbortReason, Binding, Device, OwnerState, SetSummary } from './ownerApi';

/** The §8 status list. Flags can stand beside any primary status. */
export type PrimaryStatus =
  | 'not-set-up' // 未配置
  | 'paused' // 已暂停
  | 'no-device' // 设备失效
  | 'regrant-needed' // 设备失效: a working browser lost this binding when it was confirmed again (Q35)
  | 'waiting-activity' // 等待登录后活动页
  | 'captured-not-sent' // 已采集未发送
  | 'send-unknown' // 发送结果待核对
  | 'stopped' // 发送结果待核对, with the cause the extension reported (Q4)
  | 'refused' // 发送结果待核对: Holdr received the upload and refused all of it (runState `refused`)
  | 'awaiting-review' // Holdr已接收待审（未入账）
  | 'plan-expired' // 计划已过期（仍可重新核算）
  | 'review-expired' // 待审已过期（需重采集）
  | 'committed'; // 已入账
export type StatusFlag =
  | 'partial-coverage' // 部分覆盖
  | 'bank-sign-in' // 需重新登录
  | 'rate-limited'; // 被限流暂停
export type PauseReason = 'server-paused' | 'issuer-off' | 'gate-blocked' | 'device-api-off' | 'needs-reconfirmation' | 'retired';
export type Tone = 'ok' | 'info' | 'warn' | 'error';
export type ExpiryLevel = 'expired' | 'day' | 'week' | 'later';

export interface BindingStatus {
  primary: PrimaryStatus;
  pauseReasons: PauseReason[];
  flags: StatusFlag[];
  tone: Tone;
  /** The observation set's expiry when one is waiting for review. */
  reviewExpiresAt: string | null;
  reviewExpiry: ExpiryLevel | null;
  /** Why the extension stopped the last run, when it said so (primary `stopped`). */
  stopped: AbortReason | null;
}

const MS_DAY = 86_400_000;

/** "Now" on the server's clock: its `generatedAt` plus what has elapsed here since the answer arrived. */
export function serverNow(state: Pick<OwnerState, 'generatedAt'>, receivedAt: number, now: number): number {
  return Date.parse(state.generatedAt) + Math.max(0, now - receivedAt);
}

export function expiryLevel(expiresAt: string, now: number): ExpiryLevel {
  const left = Date.parse(expiresAt) - now;
  if (left <= 0) return 'expired';
  if (left <= MS_DAY) return 'day';
  if (left <= 7 * MS_DAY) return 'week';
  return 'later';
}

export function isActiveDevice(device: Device, now: number): boolean {
  return device.status === 'active' && (device.deviceExpiresAt === null || Date.parse(device.deviceExpiresAt) > now);
}

/** The browsers holding a current grant for this binding (pending ones included). */
export function devicesOf(state: OwnerState, bindingId: string): Device[] {
  return state.devices.filter((device) => device.bindingIds.includes(bindingId));
}

/** Working browsers whose grant for this binding lapsed when it was confirmed again without them (Q35). */
export function staleDevicesOf(state: OwnerState, bindingId: string, now: number): Device[] {
  return state.devices.filter((device) => device.staleBindingIds.includes(bindingId) && isActiveDevice(device, now));
}

export function pauseReasons(binding: Binding, state: OwnerState): PauseReason[] {
  const reasons: PauseReason[] = [];
  if (state.settings.paused) reasons.push('server-paused');
  if (!state.settings.issuers.find((item) => item.issuer === binding.issuer)?.enabled) reasons.push('issuer-off');
  if (state.gate === 'blocked') reasons.push('gate-blocked');
  if (state.deviceApi === 'disabled') reasons.push('device-api-off');
  if (binding.status === 'needs-reconfirmation') reasons.push('needs-reconfirmation');
  if (binding.status === 'retired') reasons.push('retired');
  return reasons;
}

const OPEN = new Set(['accepted-uncommitted', 'needs-review', 'blocked-review', 'recovery-review']);

/** A run the owner cancelled is routine; one the extension had to stop needs the owner. */
const ABORT_TONE: Record<AbortReason, Tone> = {
  'user-cancelled': 'info',
  'not-signed-in': 'warn',
  'site-permission-revoked': 'warn',
  'unknown-page-structure': 'warn',
  'certificate-error': 'error',
};

/**
 * One binding's place in the §8 status list. Precedence: paused, not set up, no working device, then what the last run
 * says: its own state (Q36) first, so a run closed early never looks "captured, not sent" for the rest of its 10 minutes.
 */
export function bindingStatus(binding: Binding, state: OwnerState, now: number): BindingStatus {
  const reasons = pauseReasons(binding, state);
  const run = binding.sync.lastRun;
  const flags: StatusFlag[] = [];
  if (run && run.completeness !== null) {
    if (run.terminations.includes('auth-required')) flags.push('bank-sign-in');
    if (run.terminations.includes('rate-limited')) flags.push('rate-limited');
    if (run.completeness !== 'complete') flags.push('partial-coverage');
  }
  const reviewExpiresAt = run && OPEN.has(run.acceptance) ? run.observationExpiresAt : null;
  const reviewExpiry = reviewExpiresAt ? expiryLevel(reviewExpiresAt, now) : null;
  const stopped = run && run.runState === 'aborted' ? run.abortReason : null;
  const result = (primary: PrimaryStatus, tone: Tone): BindingStatus => ({
    primary, pauseReasons: reasons, flags, tone, reviewExpiresAt, reviewExpiry, stopped: primary === 'stopped' ? stopped : null,
  });

  if (reasons.length > 0) return result('paused', 'warn');
  const devices = devicesOf(state, binding.bindingId);
  if (!devices.some((device) => isActiveDevice(device, now))) {
    if (staleDevicesOf(state, binding.bindingId, now).length > 0) return result('regrant-needed', 'warn');
    const pending = devices.some((device) => device.status === 'pending');
    return devices.length === 0 || pending ? result('not-set-up', 'info') : result('no-device', 'error');
  }
  if (!run) return result('waiting-activity', 'info');
  switch (run.runState) {
    case 'open':
      // Holdr's answer is from before the run's 10 minutes ran out; past them nothing more can arrive.
      return Date.parse(run.runExpiresAt) > now ? result('captured-not-sent', 'info') : result('send-unknown', 'warn');
    case 'aborted':
      return stopped ? result('stopped', ABORT_TONE[stopped]) : result('send-unknown', 'warn');
    case 'refused':
      return result('refused', 'warn');
    case 'expired':
      return result('send-unknown', 'warn');
    default:
      break;
  }
  if (OPEN.has(run.acceptance)) {
    if (run.planExpiresAt !== null && Date.parse(run.planExpiresAt) <= now) return result('plan-expired', 'warn');
    return result('awaiting-review', reviewExpiry === 'day' || reviewExpiry === 'expired' ? 'error' : reviewExpiry === 'week' ? 'warn' : 'info');
  }
  if (run.acceptance === 'expired-unreviewed') return result('review-expired', 'error');
  if (run.acceptance === 'committed') return result('committed', 'ok');
  return result('waiting-activity', 'info');
}

/** The set's plan, as the owner can use it right now. */
export function planUsable(set: Pick<SetSummary, 'plan'>, now: number): boolean {
  return set.plan !== null && set.plan.state === 'valid' && Date.parse(set.plan.expiresAt) > now;
}

export type QuotaLevel = 'ok' | 'high' | 'full';
export function quotaLevel(usage: { used: number; limit: number }): QuotaLevel {
  if (usage.limit <= 0 || usage.used >= usage.limit) return 'full';
  return usage.used / usage.limit >= 0.8 ? 'high' : 'ok';
}
export function worstQuota(usage: { sets: { used: number; limit: number }; rows: { used: number; limit: number }; bytes: { used: number; limit: number } }): QuotaLevel {
  const levels = [quotaLevel(usage.sets), quotaLevel(usage.rows), quotaLevel(usage.bytes)];
  return levels.includes('full') ? 'full' : levels.includes('high') ? 'high' : 'ok';
}

export type FirstRunStepId = 'binding' | 'pair' | 'extension' | 'activity' | 'send' | 'review' | 'auto';
export interface FirstRunStep {
  id: FirstRunStepId;
  /** null: the step happens in the extension, so Holdr cannot tell. */
  done: boolean | null;
}

/** Plan §8 first-run steps: 1 (binding, then pairing), 2 in the extension, then 3–6 as Holdr sees them. */
export function firstRunSteps(state: OwnerState, now: number): FirstRunStep[] {
  const bindings = state.bindings.filter((binding) => binding.status !== 'retired');
  return [
    { id: 'binding', done: bindings.some((binding) => binding.status === 'confirmed') },
    { id: 'pair', done: state.devices.some((device) => isActiveDevice(device, now)) },
    { id: 'extension', done: null },
    { id: 'activity', done: bindings.some((binding) => binding.sync.lastRun !== null) },
    { id: 'send', done: bindings.some((binding) => binding.sync.lastAcceptedAt !== null) },
    { id: 'review', done: bindings.some((binding) => binding.sync.lastCommittedAt !== null) },
    { id: 'auto', done: bindings.some((binding) => binding.autoSync.devices.some((device) => device.enabled)) },
  ];
}

/** "in 5 days", "in 3 hours", "2 days ago": coarse on purpose, with the exact time shown beside it. */
export function relativeTime(at: string, now: number): string {
  const diff = Date.parse(at) - now;
  const abs = Math.abs(diff);
  const unit = abs >= 2 * MS_DAY ? ['day', MS_DAY] as const
    : abs >= 2 * 3_600_000 ? ['hour', 3_600_000] as const
      : abs >= 2 * 60_000 ? ['minute', 60_000] as const
        : null;
  if (!unit) return diff >= 0 ? 'in a moment' : 'just now';
  const count = Math.floor(abs / unit[1]);
  const text = `${count} ${unit[0]}${count === 1 ? '' : 's'}`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

/** A moment that has passed ("2 hours ago", "just now"): one Holdr stamped a little ahead of `now` never reads as still to come. */
export function pastTime(at: string, now: number): string {
  return Date.parse(at) >= now ? 'just now' : relativeTime(at, now);
}

/** An exact time for people: "Oct 17, 2026, 8:00 AM" in the browser's zone. */
export function exactTime(at: string): string {
  return new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
