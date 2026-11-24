/**
 * The dark, collapsible in-page status panel (plan §3.1, §8). It shows this
 * site's state, row counts, a partial-coverage hint and where to go next. It
 * is informational only: the page can read, hide or imitate it, so it has no
 * pairing, secret input, permission, send or auto-sync control and never
 * shows transaction text. Every string is set with `textContent`; styles
 * come from a constructed stylesheet inside a closed shadow root.
 */

export interface PanelView {
  readonly title: string;
  readonly status: string;
  readonly lines: readonly string[];
  readonly partial: boolean;
}

const STYLE = `
:host { all: initial; }
.panel { position: fixed; right: 12px; bottom: 12px; z-index: 2147483646; max-width: 320px; box-sizing: border-box;
  background: #15181e; color: #e6e8eb; border: 1px solid #343a46; border-radius: 8px; padding: 8px 10px;
  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.35); }
.head { display: flex; align-items: center; gap: 8px; }
.title { font-weight: 600; flex: 1; }
.toggle { all: unset; cursor: pointer; padding: 0 6px; border: 1px solid #343a46; border-radius: 4px; color: #e6e8eb; }
.toggle:focus-visible { outline: 2px solid #6ea8fe; }
.status { margin-top: 4px; color: #b9c0cb; }
.line { margin-top: 2px; }
.partial { margin-top: 4px; color: #f2c46d; }
.hint { margin-top: 6px; color: #8d96a5; }
.collapsed .body { display: none; }
`;

function applyFallbackStyle(panel: HTMLElement): void {
  const style = panel.style;
  style.position = 'fixed';
  style.right = '12px';
  style.bottom = '12px';
  style.zIndex = '2147483646';
  style.maxWidth = '320px';
  style.background = '#15181e';
  style.color = '#e6e8eb';
  style.border = '1px solid #343a46';
  style.borderRadius = '8px';
  style.padding = '8px 10px';
  style.font = '12px/1.4 system-ui, sans-serif';
}

export interface Panel {
  update(view: PanelView): void;
  remove(): void;
}

export function createPanel(doc: Document): Panel {
  const host = doc.createElement('div');
  const shadow = host.attachShadow({ mode: 'closed' });
  const panel = doc.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'status');
  panel.setAttribute('aria-live', 'polite');
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLE);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    applyFallbackStyle(panel);
  }

  const head = doc.createElement('div');
  head.className = 'head';
  const title = doc.createElement('span');
  title.className = 'title';
  const toggle = doc.createElement('button');
  toggle.className = 'toggle';
  toggle.type = 'button';
  toggle.textContent = '–';
  toggle.setAttribute('aria-label', 'Collapse Holdr status');
  head.append(title, toggle);

  const body = doc.createElement('div');
  body.className = 'body';
  const status = doc.createElement('div');
  status.className = 'status';
  const lines = doc.createElement('div');
  const partial = doc.createElement('div');
  partial.className = 'partial';
  const hint = doc.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'To review and send, open the Holdr extension from the browser toolbar. Nothing is sent from this page.';
  body.append(status, lines, partial, hint);
  panel.append(head, body);
  shadow.append(panel);

  toggle.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    toggle.textContent = collapsed ? '+' : '–';
    toggle.setAttribute('aria-label', collapsed ? 'Expand Holdr status' : 'Collapse Holdr status');
  });

  const attach = () => {
    if (!host.isConnected) (doc.body ?? doc.documentElement).append(host);
  };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', attach, { once: true });
  else attach();

  return {
    update(view) {
      title.textContent = view.title;
      status.textContent = view.status;
      lines.replaceChildren(
        ...view.lines.slice(0, 8).map((text) => {
          const line = doc.createElement('div');
          line.className = 'line';
          line.textContent = text;
          return line;
        }),
      );
      partial.textContent = view.partial ? 'Coverage is partial: rows the site has not shown or returned are not included.' : '';
      attach();
    },
    remove() {
      host.remove();
    },
  };
}
