import type { GainLossTone } from '@finance-tracker/shared';

/** A shown value's tone as a class: the gain or loss colour, or none for one that shows as zero or is unknown. */
export function toneClass(tone: GainLossTone): string {
  return tone === 'neutral' ? '' : tone;
}

/** A class list with a shown value's tone added: "day-change gain", or just "day-change" for a zero. */
export function withTone(className: string, tone: GainLossTone): string {
  return tone === 'neutral' ? className : `${className} ${tone}`;
}

/** A shown value's tone as Trend draws it: up for a gain, down for a loss, no arrow for one that shows as zero. */
export function toneArrow(tone: GainLossTone): number {
  return tone === 'gain' ? 1 : tone === 'loss' ? -1 : 0;
}
