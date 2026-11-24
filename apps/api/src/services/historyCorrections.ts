/**
 * A correction that replaces an account's cash with the broker's figure, recorded in
 * account_history_invalidations. Unlike added activity, which leaves the history before its effective
 * date right, nothing observed before a cash correction is known to have held the right cash, so a
 * chart never measures a change across one.
 */
export const FIDELITY_CASH_ADOPTED_REASON = 'fidelity investing cash adopted';
