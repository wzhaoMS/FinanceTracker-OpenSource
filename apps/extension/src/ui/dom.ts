/**
 * The only way the popup and options page build DOM: elements, text nodes and
 * an allowlist of attributes. There is no innerHTML, no HTML parsing, no
 * links built from data and no event-handler attributes; every value from
 * Holdr, an issuer page or storage is rendered as plain text (plan §3.2).
 */

type Child = Node | string | number | null | undefined | false;

const ALLOWED_ATTRIBUTES = new Set([
  'id', 'class', 'type', 'name', 'value', 'for', 'role', 'title', 'placeholder', 'autocomplete', 'spellcheck',
  'maxlength', 'data-testid', 'aria-label', 'aria-live', 'aria-describedby', 'aria-expanded', 'tabindex', 'lang',
]);

export interface ElementProps {
  readonly className?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly text?: string;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  readonly onClick?: (event: MouseEvent) => void;
  readonly onChange?: (event: Event) => void;
  readonly onInput?: (event: Event) => void;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: ElementProps = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (!ALLOWED_ATTRIBUTES.has(name)) throw new Error('attribute not allowed');
    node.setAttribute(name, value);
  }
  if (props.text !== undefined) node.textContent = props.text;
  if (props.disabled !== undefined && 'disabled' in node) (node as HTMLButtonElement).disabled = props.disabled;
  if (props.checked !== undefined && node instanceof HTMLInputElement) node.checked = props.checked;
  if (props.onClick) node.addEventListener('click', props.onClick as EventListener);
  if (props.onChange) node.addEventListener('change', props.onChange);
  if (props.onInput) node.addEventListener('input', props.onInput);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  return node;
}

export function option(value: string, label: string, selected = false): HTMLOptionElement {
  const node = el('option', { attrs: { value }, text: label });
  node.selected = selected;
  return node;
}

/** Holdr minor units as a decimal string (two places, USD), by integer arithmetic only. */
export function formatMinor(minor: number): string {
  if (!Number.isSafeInteger(minor)) return '?';
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return 'expired';
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A short form of an opaque id for display (prefix and first letters). */
export function shortId(id: string | null): string {
  if (!id) return '—';
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}
