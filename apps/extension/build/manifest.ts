/**
 * The two build targets' manifests. Production and test differ only in the
 * Holdr origin, the issuer origins (derived from the adapters compiled into
 * the build), the pinned public key (extension id) and the name. Everything
 * else, including the extension-pages CSP shape, is identical.
 */
import type { BuildTarget } from '../src/config/targetTypes.js';

/** Plan §3.3: the four issuer origins a production adapter may ever request, one site each. */
export const PRODUCTION_ISSUER_ORIGINS = Object.freeze([
  'https://secure.chase.com',
  'https://global.americanexpress.com',
  'https://online.citi.com',
  'https://connect.secure.wellsfargo.com',
]);

export const TEST_HOST = /^http:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.e3\.test$/;
/** The synthetic Holdr of the acceptance suite (E2c's `DEVICE_TEST_ORIGIN`): reachable only through that suite's egress gate. */
export const ACCEPTANCE_HOLDR_ORIGIN = 'https://holdr.test';

const PRODUCTION_KEY = Object.freeze({
  id: 'lmkonkgaegpbbdkngajdmlgghkchjdnc',
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqedS0YEsK7IBfs8st3d4qUZEEbN88vWEtqDkNWRkhYwK9r5MUwLnbcVraY/3I9kK/8X0aDMrcuxkp82j6inDOwg1KkD+kMvkndHqF6Y6q1tnGzBDrQQyAPMDB3wsw/GMlUjl0CgY//CWQLcFj/Xg2wTb+1SztD5p3RM6CMguvuTlm9TGKID+0j7hErDFLaRTbIqXHhmmLneiGZZhvAEwWp4K2HFMsiwWPDdpfn6eYfXueGDJpfE8N7ljPVDXhLAhd16s0Fu6aG5OhfGWskcBfgueZMuxqceyhZ8N8DtuVK6m6EhBIUbAMc9rYRNDiZHhcqEaNS8zTLe1KOIoXGew+wIDAQAB',
});

/**
 * Public keys only (SubjectPublicKeyInfo, DER, base64): they pin the extension
 * ids. The private keys were discarded when generated; unpacked loading never
 * needs them, and no one can sign a CRX for these ids. The acceptance build
 * carries the production id on purpose: it is the one id Holdr's device API
 * admits (E2c M6), and the build can reach only the synthetic Holdr.
 */
export const KEYS = Object.freeze({
  production: PRODUCTION_KEY,
  test: Object.freeze({
    id: 'icilknejhlhobkgcejnkbhbebnkfldmc',
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA8km3v2WA2IkE1bNiIjaQLfq6Hcn2AJNOqodL5Kj+DtpMZiYLB01H5OqYVcGzUv/spK0FKaoWT1AcJ8ABxMKifVwR6ab6yjcN6inyAguvBPKzkXaj0wJ8AGlDYk5y5EzXYl5kgftDTyWJFudeAu/4bQDUkWYwdw7Ufszk/A6Ut1wzYc1OSdJZ2dAngbNlfxtHQQtycsq+nztgVBt/4AUTamInwJkj5WDUQ0yO3ayYMXMWbPlE4Sxtx0yCVPDvTE9MRdJ/WaaUiJsSMKgxRdWhoO7V6DUSHqIze1weAr4jhEheFC6ZNW67+asfjG1hWbXGZbM3xQhGqijmcPCQUMK62wIDAQAB',
  }),
  acceptance: PRODUCTION_KEY,
});

/** Plan §3.3, exactly; only the connect-src origin differs between targets. */
export function extensionPagesCsp(holdrOrigin: string): string {
  return `default-src 'none'; script-src 'self'; object-src 'none'; style-src 'self'; img-src 'self'; connect-src ${holdrOrigin}; base-uri 'none'; form-action 'none'`;
}

export const EXTENSION_VERSION = '0.1.0';
export const MINIMUM_CHROME_VERSION = '121';

export function buildManifest(target: BuildTarget): Record<string, unknown> {
  const optional = target.adapters.map((adapter) => adapter.hostPermission);
  const manifest: Record<string, unknown> = {
    manifest_version: 3,
    name: target.name === 'test' ? 'Holdr card sync (TEST BUILD: fake issuers only)' : target.name === 'acceptance' ? 'Holdr card sync (ACCEPTANCE BUILD: fake issuers, synthetic Holdr)' : 'Holdr card sync',
    version: EXTENSION_VERSION,
    description: "Holdr's own extension: reads card activity you open, shows the exact preview, and sends it to your Holdr only when you say so.",
    key: KEYS[target.name].key,
    minimum_chrome_version: MINIMUM_CHROME_VERSION,
    incognito: 'not_allowed',
    permissions: ['scripting', 'storage'],
    host_permissions: [`${target.holdrOrigin}/*`],
    background: { service_worker: 'worker.js', type: 'module' },
    action: { default_popup: 'popup.html', default_title: 'Holdr card sync' },
    options_ui: { page: 'options.html', open_in_tab: true },
    content_security_policy: { extension_pages: extensionPagesCsp(target.holdrOrigin) },
  };
  if (optional.length > 0) manifest.optional_host_permissions = optional;
  return manifest;
}
