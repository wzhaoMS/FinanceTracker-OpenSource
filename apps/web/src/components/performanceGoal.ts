/**
 * The household goal the Performance panel tracks: a target, a date and, optionally, the money added each year. It is
 * kept in this browser only (localStorage; signing out keeps it, see services/browserCache.ts). There is no default
 * goal: until someone sets one, the panel offers to set one instead of measuring the portfolio against a made-up target.
 */
export interface GoalDraft {
  target: string;
  by: string;
  /** Empty: use the recent net money added. */
  yearlyAdded: string;
}

export const GOAL_KEY = 'finance-tracker:goal:v1';
/** What "Set a goal" starts from: every field blank. */
export const EMPTY_GOAL: GoalDraft = { target: '', by: '', yearlyAdded: '' };

type GoalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const hasContent = (draft: GoalDraft) => [draft.target, draft.by, draft.yearlyAdded].some((field) => field.trim() !== '');

/** This browser's goal, or null when it has none: nothing stored, nothing but blanks, or something that is not a goal. */
export function readGoal(storage: GoalStorage | null): GoalDraft | null {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(GOAL_KEY) ?? 'null');
    if (parsed && typeof parsed === 'object') {
      const { target, by, yearlyAdded } = parsed as Record<string, unknown>;
      if (typeof target === 'string' && typeof by === 'string' && typeof yearlyAdded === 'string') {
        const draft = { target, by, yearlyAdded };
        return hasContent(draft) ? draft : null;
      }
    }
  } catch {
    /* unreadable storage or not JSON: no goal */
  }
  return null;
}

/** Keeps `draft` as this browser's goal. No goal, or one with every field blank, removes the stored one. */
export function writeGoal(storage: GoalStorage | null, draft: GoalDraft | null): void {
  try {
    if (draft && hasContent(draft)) storage?.setItem(GOAL_KEY, JSON.stringify(draft));
    else storage?.removeItem(GOAL_KEY);
  } catch {
    /* storage refused: the goal lasts as long as the page */
  }
}
