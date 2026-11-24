import { CARD_SYNC_IDENTITY_NAMESPACES, type CardSyncIdentityNamespace } from '@finance-tracker/shared';

/**
 * Automatic admission per v2 identity namespace (E1b design §4.4, Q5):
 * `autoInsert` would let a device commit a new row of the namespace without
 * the owner's plan, `lifecycle` would let its ids' pending → posted and
 * removal changes apply without review. Every gate is closed: each opens only
 * with its own evidence (the E4–E7 gates), in a reviewed change of its own,
 * so the types below are the literal `false` and opening one is a type
 * change too. The classifier (E1b slice 2) reads admissions from here and
 * nowhere else; v1 file imports never use any (NO_ADMISSIONS).
 */
export interface CardSyncAdmission {
  readonly autoInsert: false;
  readonly lifecycle: false;
}

const CLOSED: CardSyncAdmission = Object.freeze({ autoInsert: false, lifecycle: false });

const allClosed = (): Readonly<Record<CardSyncIdentityNamespace, CardSyncAdmission>> => Object.freeze(
  Object.fromEntries(CARD_SYNC_IDENTITY_NAMESPACES.map((namespace) => [namespace, CLOSED])) as Record<
    CardSyncIdentityNamespace, CardSyncAdmission>,
);

export const CARD_SYNC_ADMISSIONS = allClosed();

/** The admissions of a v1 file import: none, whatever CARD_SYNC_ADMISSIONS says. */
export const NO_ADMISSIONS = allClosed();
