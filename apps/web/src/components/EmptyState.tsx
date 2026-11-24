import type { ReactNode } from 'react';

import { Plus } from './icons';
import './investing-entry.css';

export interface EmptyStateAction {
  label: string;
  onAction: () => void;
}

interface Props {
  title: string;
  body?: ReactNode;
  /** Optional CTA. Renders as a brand-tinted button. */
  actionLabel?: string;
  onAction?: () => void;
  /** The next steps, when there is more than one (the first is the main one). */
  actions?: EmptyStateAction[];
  /** Decorative icon beside the title. */
  icon?: ReactNode;
}

/**
 * Empty-state card. Round 3 (3.C1).
 *
 * A card that says what is missing and offers the next step for it as a button: with no accounts, "Add account";
 * with accounts but no trades, "Add transaction" and "Import". Never a blank gray viewport.
 *
 * Slots: title, optional body copy, optional actions. The first action uses the calmed brand-92 button treatment
 * shared with `.accounts-new` / form-save buttons; a second one is quieter.
 */
export function EmptyState({ title, body, actionLabel, onAction, actions, icon }: Props) {
  const steps: EmptyStateAction[] = actions ?? (actionLabel && onAction ? [{ label: actionLabel, onAction }] : []);
  return (
    <div className="empty-state" role="status">
      {icon ? <div className="empty-state-icon">{icon}</div> : null}
      <div className="empty-state-title">{title}</div>
      {body ? <div className="empty-state-body">{body}</div> : null}
      {steps.length > 0 ? (
        <div className="empty-state-actions">
          {steps.map((step, index) => (
            <button
              key={step.label}
              type="button"
              className={index === 0 ? 'accounts-new empty-state-cta' : 'empty-state-cta empty-state-secondary'}
              onClick={step.onAction}
            >
              {index === 0 ? <Plus size={14} /> : null}
              {step.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
