import { useState } from 'react';

import { Package } from '../icons';
import { amazonItemImageHref } from './amazonApi';

export type AmazonThumbSize = 'small' | 'medium' | 'large';
const PIXELS: Record<AmazonThumbSize, number> = { small: 40, medium: 56, large: 72 };

/**
 * An Amazon item's product thumbnail, beside its title as on Amazon's own order page, so what was bought shows at a
 * glance. It comes from Holdr's own origin (the owner-only cache an operator filled), never from Amazon, and only
 * when the API says one is cached; otherwise, or when it fails to load, a neutral placeholder. Decorative: the title
 * beside it names the item.
 */
export function AmazonItemThumb({ itemRef, image, size }: {
  itemRef: string | null;
  image: boolean | undefined;
  size: AmazonThumbSize;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const href = image === true && itemRef ? amazonItemImageHref(itemRef) : null;
  const pixels = PIXELS[size];
  if (!href || failed === href) {
    return (
      <span className={`amazon-thumb ${size} placeholder`} aria-hidden="true">
        <Package size={Math.round(pixels * 0.45)} />
      </span>
    );
  }
  return (
    <img
      className={`amazon-thumb ${size}`}
      src={href}
      alt=""
      width={pixels}
      height={pixels}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(href)}
    />
  );
}
