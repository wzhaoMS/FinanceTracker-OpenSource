/**
 * Inline SVG icons. Lucide-style: 24×24 viewBox, currentColor stroke,
 * 1.5 stroke-width, round caps + joins. We render at 16×16 by default.
 *
 * Kept in one file as named exports so the bundle ships only the icons
 * actually imported (Vite tree-shakes unused exports).
 *
 * Why inline SVG vs pulling lucide-react: this app already has a small
 * dependency footprint and these icons are static. A handful of named
 * components is cheaper than a 200KB peer dep + tree-shake config.
 */
import { useId, type SVGProps } from 'react';

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children' | 'strokeWidth'> {
  size?: number | string;
  strokeWidth?: number;
}

function Base({ size = 16, strokeWidth = 1.5, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...rest,
  };
}

export function ChevronRight(props: IconProps) {
  return (<svg {...Base(props)}><path d="m9 18 6-6-6-6" /></svg>);
}

export function ChevronDown(props: IconProps) {
  return (<svg {...Base(props)}><path d="m6 9 6 6 6-6" /></svg>);
}

export function TrendUp(props: IconProps) {
  return (
    <svg {...Base(props)}>
      <path d="m5 14 4-4 3 3 7-7" />
      <path d="M14 6h5v5" />
    </svg>
  );
}

export function TrendDown(props: IconProps) {
  return (
    <svg {...Base(props)}>
      <path d="m5 10 4 4 3-3 7 7" />
      <path d="M14 18h5v-5" />
    </svg>
  );
}

export function ArrowUp(props: IconProps) {
  return (<svg {...Base(props)}><path d="M12 19V5" /><path d="m6 11 6-6 6 6" /></svg>);
}

export function ArrowDown(props: IconProps) {
  return (<svg {...Base(props)}><path d="M12 5v14" /><path d="m6 13 6 6 6-6" /></svg>);
}

export function LineChart(props: IconProps) {
  return (
    <svg {...Base(props)}>
      <path d="M3 3v18h18" />
      <path d="m7 14 4-4 3 3 6-6" />
    </svg>
  );
}

export function RefreshCw(props: IconProps) {
  return (
    <svg {...Base(props)}>
      <path d="M21 12a9 9 0 1 1-3.5-7.1" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

export function Info(props: IconProps) {
  return (
    <svg {...Base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function AlertTriangle(props: IconProps) {
  return (
    <svg {...Base(props)}>
      <path d="M10.3 4.2 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function HelpCircle(props: IconProps) {
  return (
    <svg {...Base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function Lock(props: IconProps) {
  return (
    <svg {...Base(props)}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function Clock(props: IconProps) {
  return (
    <svg {...Base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function MoreVertical(props: IconProps) {
  return (
    <svg {...Base(props)}>
      <circle cx="12" cy="6" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function Plus(props: IconProps) {
  return (<svg {...Base(props)}><path d="M12 5v14M5 12h14" /></svg>);
}

export function X(props: IconProps) {
  return (<svg {...Base(props)}><path d="m6 6 12 12M18 6 6 18" /></svg>);
}

export function Trash2(props: IconProps) {
  return (
    <svg {...Base(props)}>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 15H6L5 6" />
      <path d="M10 11v5M14 11v5" />
    </svg>
  );
}

export function Search(props: IconProps) {
  return (
    <svg {...Base(props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function Package(props: IconProps) {
  return (
    <svg {...Base(props)}>
      <path d="m3 7.5 9-4.5 9 4.5-9 4.5-9-4.5Z" />
      <path d="M3 7.5v9l9 4.5 9-4.5v-9" />
      <path d="M12 12v9" />
    </svg>
  );
}

/**
 * Small ▲ / ▼ glyph beside signed numbers. Renders nothing when value is 0.
 * 10×10 by default so it sits next to a 14px line of text without dominating.
 */
export function Trend({ value, size = 10 }: { value: number; size?: number }) {
  if (value === 0) return null;
  const Cmp = value > 0 ? ArrowUp : ArrowDown;
  return <Cmp size={size} strokeWidth={2.4} aria-hidden style={{ verticalAlign: '-1px', marginRight: 2 }} />;
}

/**
 * Holdr brand mark (`docs/assets/brand/mark.svg`): rounded evergreen tile with
 * two stacked gold ingot bars forming an H. Uses per-instance gradient IDs so
 * multiple marks on a page never collide.
 */
export function HoldrMark({ size = 26, className }: { size?: number; className?: string }) {
  const uid = useId().replace(/:/g, '');
  const tileId = `holdr-mark-tile-${uid}`;
  const goldId = `holdr-mark-gold-${uid}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={tileId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#14857A" />
          <stop offset="1" stopColor="#0A5B54" />
        </linearGradient>
        <linearGradient id={goldId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FCD535" />
          <stop offset="1" stopColor="#F2BC0C" />
        </linearGradient>
      </defs>
      <path fill={`url(#${tileId})`} d="M41.09,0C49.11,0 53.12,0 56.18,1.56C58.88,2.93 61.07,5.12 62.44,7.82C64,10.88 64,14.89 64,22.91L64,41.09C64,49.11 64,53.12 62.44,56.18C61.07,58.88 58.88,61.07 56.18,62.44C53.12,64 49.11,64 41.09,64L22.91,64C14.89,64 10.88,64 7.82,62.44C5.12,61.07 2.93,58.88 1.56,56.18C0,53.12 0,49.11 0,41.09L0,22.91C0,14.89 0,10.88 1.56,7.82C2.93,5.12 5.12,2.93 7.82,1.56C10.88,0 14.89,0 22.91,0L41.09,0Z" />
      <path fill="#FFFFFF" fillOpacity=".1" d="M41.09,0C49.11,0 53.12,0 56.18,1.56C58.88,2.93 61.07,5.12 62.44,7.82C64,10.88 64,14.89 64,22.91L64,41.09C64,49.11 64,53.12 62.44,56.18C61.07,58.88 58.88,61.07 56.18,62.44C53.12,64 49.11,64 41.09,64L22.91,64C14.89,64 10.88,64 7.82,62.44C5.12,61.07 2.93,58.88 1.56,56.18C0,53.12 0,49.11 0,41.09L0,22.91C0,14.89 0,10.88 1.56,7.82C2.93,5.12 5.12,2.93 7.82,1.56C10.88,0 14.89,0 22.91,0L41.09,0ZM61.68,8.42C60.34,5.8 58.2,3.66 55.58,2.32C52.59,0.8 48.68,0.8 40.87,0.8L23.13,0.8C15.32,0.8 11.41,0.8 8.42,2.32C5.8,3.66 3.66,5.8 2.32,8.42C0.8,11.41 0.8,15.32 0.8,23.13L0.8,40.87C0.8,48.68 0.8,52.59 2.32,55.58C3.66,58.2 5.8,60.34 8.42,61.68C11.41,63.2 15.32,63.2 23.13,63.2L40.87,63.2C48.68,63.2 52.59,63.2 55.58,61.68C58.2,60.34 60.34,58.2 61.68,55.58C63.2,52.59 63.2,48.68 63.2,40.87L63.2,23.13C63.2,15.32 63.2,11.41 61.68,8.42Z" />
      <path fill="#FFFFFF" fillOpacity=".1" d="M41.09,0C49.11,0 53.12,0 56.18,1.56C58.88,2.93 61.07,5.12 62.44,7.82C64,10.88 64,14.89 64,22.91C64,15.48 63.94,11.66 62.44,8.72C61.07,6.02 58.88,3.83 56.18,2.46C53.12,0.9 49.11,0.9 41.09,0.9L22.91,0.9C14.89,0.9 10.88,0.9 7.82,2.46C5.12,3.83 2.93,6.02 1.56,8.72C0,11.78 0,15.79 0,23.81L0,22.91C0,14.89 0,10.88 1.56,7.82C2.93,5.12 5.12,2.93 7.82,1.56C10.88,0 14.89,0 22.91,0L41.09,0Z" />
      <path fill="#042F2B" fillOpacity=".32" d="M16.76,18.51C16.9,17.81 17.52,17.3 18.23,17.3L26.1,17.3C26.6,17.3 27,17.7 27,18.2L27,25.9C27,26.45 27.45,26.9 28,26.9L36,26.9C36.55,26.9 37,26.45 37,25.9L37,18.2C37,17.7 37.4,17.3 37.9,17.3L45.77,17.3C46.48,17.3 47.1,17.81 47.24,18.51L49.65,30.71C49.83,31.64 49.12,32.5 48.18,32.5L15.82,32.5C14.88,32.5 14.17,31.64 14.35,30.71L16.76,18.51ZM16.76,35.31C16.9,34.61 17.52,34.1 18.23,34.1L45.77,34.1C46.48,34.1 47.1,34.61 47.24,35.31L49.65,47.51C49.83,48.44 49.12,49.3 48.18,49.3L37.9,49.3C37.4,49.3 37,48.9 37,48.4L37,40.7C37,40.15 36.55,39.7 36,39.7L28,39.7C27.45,39.7 27,38.85 27,39.4L27,48.4C27,48.9 26.6,49.3 26.1,49.3L15.82,49.3C14.88,49.3 14.17,48.44 14.35,47.51L16.76,35.31Z" />
      <path fill={`url(#${goldId})`} d="M16.76,17.21C16.9,16.51 17.52,16 18.23,16L26.1,16C26.6,16 27,16.4 27,16.9L27,24.6C27,25.15 27.45,25.6 28,25.6L36,25.6C36.55,25.6 37,25.15 37,24.6L37,16.9C37,16.4 37.4,16 37.9,16L45.77,16C46.48,16 47.1,16.51 47.24,17.21L49.65,29.41C49.83,30.34 49.12,31.2 48.18,31.2L15.82,31.2C14.88,31.2 14.17,30.34 14.35,29.41L16.76,17.21ZM16.76,34.01C16.9,33.31 17.52,32.8 18.23,32.8L45.77,32.8C46.48,32.8 47.1,33.31 47.24,34.01L49.65,46.21C49.83,47.14 49.12,48 48.18,48L37.9,48C37.4,48 37,47.6 37,47.1L37,39.4C37,38.85 36.55,38.4 36,38.4L28,38.4C27.45,38.4 27,38.85 27,39.4L27,47.1C27,47.6 26.6,48 26.1,48L15.82,48C14.88,48 14.17,47.14 14.35,46.21L16.76,34.01Z" />
      <path fill="#FEF3C7" d="M27,17.6L16.68,17.6L16.76,17.21C16.9,16.51 17.52,16 18.23,16L26.1,16C26.6,16 27,16.4 27,16.9L27,17.6ZM45.77,16L37.9,16C37.4,16 37,16.4 37,16.9L37,17.6L47.32,17.6L47.24,17.21C47.1,16.51 46.48,16 45.77,16ZM47.32,34.4L16.68,34.4L16.76,34.01C16.9,33.31 17.52,32.8 18.23,32.8L45.77,32.8C46.48,32.8 47.1,33.31 47.24,34.01L47.32,34.4Z" />
      <path fill="#B7791F" fillOpacity=".5" d="M49.53,28.8L49.65,29.41C49.83,30.34 49.12,31.2 48.18,31.2L15.82,31.2C14.88,31.2 14.17,30.34 14.35,29.41L14.47,28.8L49.53,28.8ZM27,45.6L27,47.1C27,47.6 26.6,48 26.1,48L15.82,48C14.88,48 14.17,47.14 14.35,46.21L14.47,45.6L27,45.6ZM49.53,45.6L37,45.6L37,47.1C37,47.6 37.4,48 37.9,48L48.18,48C49.12,48 49.83,47.14 49.65,46.21L49.53,45.6Z" />
    </svg>
  );
}
