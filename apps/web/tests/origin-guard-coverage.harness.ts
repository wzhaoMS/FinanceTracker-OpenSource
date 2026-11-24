import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { closeServer, elsewhereServer, listen, selfSignedCertificate, type Elsewhere, type Recorder } from './guardServers';
import { expectNoForeignTraffic, watchOrigin } from './originGuard';

/**
 * The origin-guard coverage table, row by row: every way this browser build can reach the network,
 * against the origin guard and a second loopback origin (guardServers.ts) that stands in for every
 * other host. The app is served over HTTP, and over HTTPS for the rows that need it. A row the
 * guard observes or switches off passes only if the guard reports it, so a test under it fails,
 * and, where the row says so, nothing reached the other origin: no request, WebSocket or
 * connection. A row that is not network-capable here passes only if nothing reached
 * it and the guard had nothing to report. The feature checks fail when this build gains an API the
 * table says it lacks, and the surface snapshot when it gains or loses any API at all.
 * origin-guard.harness.ts covers workers, WebRTC, WebTransport, speculation rules, popups and the
 * pages the guard watches.
 */

interface Row {
  /** Markup for the page's body, given the other origin's URL. */
  html?: (elsewhere: string) => string;
  /** A module script the page runs as it loads, or, with `activate`, when a button is clicked. */
  script?: (elsewhere: string) => string;
  activate?: boolean;
  /** Response headers; a list sends the header once per value. */
  headers?: (elsewhere: string) => Record<string, string | string[]>;
  earlyHints?: (elsewhere: string) => Record<string, string[]>;
  /** An element to click, for a ping, a download or a form. */
  click?: string;
  /** The test closes the page once it has loaded. */
  close?: boolean;
  /** The app serves the page over HTTPS, with a certificate made for the run. */
  https?: boolean;
  /** Every line the guard must report. */
  reported: RegExp[];
  /** Nothing reaches the other origin: no request, WebSocket or connection. */
  refused: boolean;
}

/**
 * An expected report line: `{E}` stands for the other origin (`{WS}` as a WebSocket URL), `{APP}`
 * for the app's, `{SE}` and `{SAPP}` for the same over HTTPS, and `...` for anything. A channel
 * the guard cannot watch adds its suffix.
 */
function line(text: string, unwatched: boolean): RegExp {
  const pattern = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{E\\\}|\\\{APP\\\}/g, 'http://127\\.0\\.0\\.1:\\d+')
    .replace(/\\\{SE\\\}|\\\{SAPP\\\}/g, 'https://127\\.0\\.0\\.1:\\d+')
    .replace(/\\\{WS\\\}/g, 'ws://127\\.0\\.0\\.1:\\d+')
    .replace(/\\\.\\\.\\\./g, '.*');
  return new RegExp(`^${pattern}${unwatched ? ' \\(a channel the guard cannot watch\\)' : ''}$`);
}
/** A request Playwright reported, which the guard refused. */
const seen = (resourceType: string, path: string) => line(`${resourceType} {E}${path}`, false);
/** An attempt at a switched-off API, or what the guard noted from the browser or a response. */
const off = (channel: string, target: string) => line(`${channel} ${target}`, true);
const noted = (text: string) => line(text, true);
const closed = line('the page at {APP}/... closed during the test: what it starts while closing goes past the guard', false);

/** Calls that may reject, one after another. */
const each = (calls: string[]) => calls.map((call) => `try { await ${call}; } catch {}`).join('\n');

const ROWS: Record<string, Row> = {
  // Observed: Playwright reports the request, and the guard refuses it.
  'XMLHttpRequest': { script: (e) => `const x = new XMLHttpRequest(); x.open('GET', '${e}/xhr'); x.send();`, reported: [seen('xhr', '/xhr')], refused: true },
  'XMLHttpRequest, synchronous': { script: (e) => `const x = new XMLHttpRequest(); x.open('GET', '${e}/sync-xhr', false); try { x.send(); } catch {}`, reported: [seen('xhr', '/sync-xhr')], refused: true },
  'EventSource': { script: (e) => `new EventSource('${e}/sse');`, reported: [seen('eventsource', '/sse')], refused: true },
  '<a ping>': { html: (e) => `<a id="go" href="/stay" ping="${e}/ping">go</a>`, click: '#go', reported: [seen('ping', '/ping')], refused: true },
  '<area ping>': {
    html: (e) => `<img src="/pixel" usemap="#m" width="60" height="60" style="display:block"><map name="m"><area shape="rect" coords="0,0,60,60" href="/stay" ping="${e}/area-ping"></map>`,
    click: 'img',
    reported: [seen('ping', '/area-ping')],
    refused: true,
  },
  'Image()': { script: (e) => `new Image().src = '${e}/image';`, reported: [seen('image', '/image')], refused: true },
  '<img srcset>': { html: (e) => `<img srcset="${e}/srcset 1x">`, reported: [seen('image', '/srcset')], refused: true },
  'CSS url()': { html: (e) => `<style>body { background-image: url(${e}/background); }</style>`, reported: [seen('image', '/background')], refused: true },
  'CSS @import': { html: (e) => `<style>@import url(${e}/import.css);</style>`, reported: [seen('stylesheet', '/import.css')], refused: true },
  'FontFace': { script: (e) => `await new FontFace('f', 'url(${e}/font)').load().catch(() => {});`, reported: [seen('font', '/font')], refused: true },
  '<video src>': { html: (e) => `<video src="${e}/video" preload="auto"></video>`, reported: [seen('media', '/video')], refused: true },
  '<video poster>': { html: (e) => `<video poster="${e}/poster"></video>`, reported: [seen('image', '/poster')], refused: true },
  '<track>': { html: (e) => `<video src="/stay"><track default kind="captions" src="${e}/track"></video>`, reported: [seen('texttrack', '/track')], refused: true },
  '<script src>': { html: (e) => `<script src="${e}/script.js"></script>`, reported: [seen('script', '/script.js')], refused: true },
  'import()': { script: (e) => `await import('${e}/module.js').catch(() => {});`, reported: [seen('script', '/module.js')], refused: true },
  '<iframe>': { html: (e) => `<iframe src="${e}/iframe"></iframe>`, reported: [seen('document', '/iframe')], refused: true },
  '<object>': { html: (e) => `<object data="${e}/object"></object>`, reported: [seen('document', '/object')], refused: true },
  '<embed>': { html: (e) => `<embed src="${e}/embed">`, reported: [seen('document', '/embed')], refused: true },
  'SVG <image>': { html: (e) => `<svg><image href="${e}/svg-image" width="10" height="10"/></svg>`, reported: [seen('image', '/svg-image')], refused: true },
  '<link rel=preload>': { html: (e) => `<link rel="preload" as="image" href="${e}/preload">`, reported: [seen('image', '/preload')], refused: true },
  '<link rel=prefetch>': { html: (e) => `<link rel="prefetch" href="${e}/prefetch">`, reported: [seen('other', '/prefetch')], refused: true },
  '<link rel=modulepreload>': { html: (e) => `<link rel="modulepreload" href="${e}/modulepreload.js">`, reported: [seen('script', '/modulepreload.js')], refused: true },
  '<link rel=compression-dictionary>': { html: (e) => `<link rel="compression-dictionary" href="${e}/dictionary">`, reported: [seen('other', '/dictionary')], refused: true },
  '<script type=webbundle>': {
    html: (e) => `<script type="webbundle">${JSON.stringify({ source: `${e}/bundle.wbn`, resources: [`${e}/in-bundle.js`] })}</script>`,
    reported: [seen('other', '/bundle.wbn')],
    refused: true,
  },
  'attributionsrc': { html: (e) => `<img src="/pixel" attributionsrc="${e}/attribution">`, reported: [seen('other', '/attribution')], refused: true },
  'Cache.add()': { script: (e) => `await caches.open('c').then((cache) => cache.add('${e}/cache')).catch(() => {});`, reported: [seen('fetch', '/cache')], refused: true },
  'location': { script: (e) => `location.href = '${e}/location';`, reported: [seen('document', '/location')], refused: true },
  '<form> submission': { html: (e) => `<form action="${e}/form" method="post"><button id="go">go</button></form>`, click: '#go', reported: [seen('document', '/form')], refused: true },
  '<meta http-equiv=refresh>': { html: (e) => `<meta http-equiv="refresh" content="0;url=${e}/refresh">`, reported: [seen('document', '/refresh')], refused: true },
  'navigation.navigate()': { script: (e) => `navigation.navigate('${e}/navigation');`, reported: [seen('document', '/navigation')], refused: true },
  '<a download>': { html: (e) => `<a id="go" href="${e}/download" download>go</a>`, click: '#go', reported: [seen('document', '/download')], refused: true },
  'CSP report-uri': {
    headers: (e) => ({ 'content-security-policy': `img-src 'none'; report-uri ${e}/csp-report` }),
    html: () => '<img src="/pixel">',
    reported: [seen('other', '/csp-report'), noted('content-security-policy header sends reports to {E}/csp-report, from {APP}/...')],
    refused: true,
  },
  // Observed, not refused: what a page asks for while it closes goes past Playwright's routing.
  'a request while the page closes': {
    script: (e) => `addEventListener('pagehide', () => { new Image().src = '${e}/while-closing'; });`,
    close: true,
    reported: [closed],
    refused: false,
  },
  // Observed: link hints, which open no connection in this build (it has no handler for them).
  '<link rel=preconnect>': { html: (e) => `<link rel="preconnect" href="${e}">`, reported: [off('link hint preconnect', '{E}/')], refused: true },
  '<link rel=dns-prefetch>': { html: (e) => `<link rel="dns-prefetch" href="${e}">`, reported: [off('link hint dns-prefetch', '{E}/')], refused: true },
  '<link rel=prerender>': { html: (e) => `<link rel="prerender" href="${e}/prerender">`, reported: [off('link hint prerender', '{E}/prerender')], refused: true },
  // Detected from the response headers.
  'Link header': {
    headers: (e) => ({ link: `<${e}/link-preload>; rel=preload; as=image, <${e}>; rel=preconnect` }),
    reported: [seen('image', '/link-preload'), noted('Link header preload {E}/link-preload on {APP}/...'), noted('Link header preconnect {E}/ on {APP}/...')],
    refused: true,
  },
  'Reporting-Endpoints, for CSP report-to and every other report': {
    headers: (e) => ({ 'reporting-endpoints': `default="${e}/reports"`, 'content-security-policy': "img-src 'none'; report-to default" }),
    html: () => '<img src="/pixel">',
    reported: [noted('reporting-endpoints header sends reports to {E}/reports, from {APP}/...')],
    refused: true,
  },
  'Report-To, with NEL': {
    headers: (e) => ({ 'report-to': JSON.stringify({ group: 'g', max_age: 60, endpoints: [{ url: `${e}/report-to` }] }), nel: JSON.stringify({ report_to: 'g', max_age: 60 }) }),
    reported: [noted('report-to header sends reports to {E}/report-to, from {APP}/...')],
    refused: true,
  },
  'Attribution-Reporting-Register-Source': {
    headers: () => ({ 'attribution-reporting-register-source': JSON.stringify({ destination: 'https://example.com' }) }),
    reported: [noted('attribution-reporting-register-source header ... on {APP}/...')],
    refused: true,
  },
  'Sec-Session-Registration': {
    headers: () => ({ 'sec-session-registration': '(ES256);path="/session";challenge="c"' }),
    reported: [noted('sec-session-registration header ... on {APP}/...')],
    refused: true,
  },
  'Origin-Trial header': { headers: () => ({ 'origin-trial': 'token' }), reported: [noted('origin-trial header token on {APP}/...')], refused: true },
  '<meta http-equiv=origin-trial>': { html: () => '<meta http-equiv="origin-trial" content="token">', reported: [off('origin trial', 'token')], refused: true },
  // An element added first and made a hint or an origin trial later, by an attribute.
  'a link hint by a rel set after the link is added': {
    script: (e) => `const link = document.createElement('link'); link.href = '${e}/late-hint'; document.head.append(link);
      await new Promise((resolve) => setTimeout(resolve, 100)); link.rel = 'preconnect';`,
    reported: [off('link hint preconnect', '{E}/late-hint')],
    refused: true,
  },
  'an origin trial by an http-equiv set after the meta is added': {
    script: () => `const meta = document.createElement('meta'); meta.content = 'late-token'; document.head.append(meta);
      await new Promise((resolve) => setTimeout(resolve, 100)); meta.httpEquiv = 'origin-trial';`,
    reported: [off('origin trial', 'late-token')],
    refused: true,
  },
  'a link hint on an HTTPS page, its href https:host:port/x': {
    https: true,
    html: (e) => `<link rel="preconnect" href="https:${new URL(e).host}/hint">`,
    reported: [off('link hint preconnect', '{SE}/hint')],
    refused: true,
  },
  'Alt-Svc': { headers: (e) => ({ 'alt-svc': `h2="${new URL(e).host}"; ma=60` }), reported: [noted('alt-svc header ... on {APP}/...')], refused: true },
  // The headers are parsed as the browser parses them: no spelling of an endpoint or a link target
  // hides it, and a header that does not parse is reported itself.
  'Report-To, its endpoint with escaped slashes': {
    headers: (e) => ({ 'report-to': JSON.stringify({ group: 'g', max_age: 600, endpoints: [{ url: `${e}/escaped` }] }).replace(/\//g, '\\/'), nel: '{"report_to":"g","max_age":600}' }),
    reported: [noted('report-to header sends reports to {E}/escaped, from {APP}/...')],
    refused: true,
  },
  'Report-To, its endpoint protocol-relative': {
    headers: (e) => ({ 'report-to': JSON.stringify({ group: 'g', max_age: 600, endpoints: [{ url: `//${new URL(e).host}/protocol-relative` }] }) }),
    reported: [noted('report-to header sends reports to {E}/protocol-relative, from {APP}/...')],
    refused: true,
  },
  'Report-To, its endpoint in mixed case, in the second of two headers': {
    headers: (e) => ({ 'report-to': ['{"group":"a","max_age":600,"endpoints":[{"url":"/own-origin"}]}', JSON.stringify({ group: 'b', max_age: 600, endpoints: [{ url: `HTTP://${new URL(e).host}/Mixed-Case` }] })] }),
    reported: [noted('report-to header sends reports to {E}/Mixed-Case, from {APP}/...')],
    refused: true,
  },
  'Report-To that does not parse': { headers: () => ({ 'report-to': '{"group":"g","endpoints":[{"url":' }), reported: [noted('report-to header that the guard cannot parse, on {APP}/...')], refused: true },
  'Reporting-Endpoints, its endpoint protocol-relative': {
    headers: (e) => ({ 'reporting-endpoints': `default="//${new URL(e).host}/protocol-relative"` }),
    reported: [noted('reporting-endpoints header sends reports to {E}/protocol-relative, from {APP}/...')],
    refused: true,
  },
  'Reporting-Endpoints, its endpoint in mixed case, in the second of two headers': {
    headers: (e) => ({ 'reporting-endpoints': ['own="/own-origin"', `csp="HTTP://${new URL(e).host}/Mixed-Case"`] }),
    reported: [noted('reporting-endpoints header sends reports to {E}/Mixed-Case, from {APP}/...')],
    refused: true,
  },
  'Reporting-Endpoints with an escape a structured field does not allow': {
    headers: (e) => ({ 'reporting-endpoints': `default="${e.replace(/\//g, '\\/')}/escaped"` }),
    reported: [noted('reporting-endpoints header that the guard cannot parse, on {APP}/...')],
    refused: true,
  },
  'Reporting-Endpoints that does not parse': { headers: () => ({ 'reporting-endpoints': 'Default=/reports' }), reported: [noted('reporting-endpoints header that the guard cannot parse, on {APP}/...')], refused: true },
  'Link headers: a quoted comma and angle bracket, a protocol-relative target, two headers': {
    headers: (e) => ({ link: [`</own-origin>; rel=preload; as=image; title="a, <b>", <//${new URL(e).host}/after-the-quote>; rel=preconnect`, `<${e}/second-header>; rel="dns-prefetch preconnect"`] }),
    reported: [noted('Link header preconnect {E}/after-the-quote on {APP}/...'), noted('Link header dns-prefetch preconnect {E}/second-header on {APP}/...')],
    refused: true,
  },
  'Link header that does not parse': { headers: (e) => ({ link: `<${e}/unclosed; rel=preload` }), reported: [noted('link header that the guard cannot parse, on {APP}/...')], refused: true },
  'Link header: an image preload whose imagesrcset is at another origin': {
    headers: (e) => ({ link: `</own-origin.png>; rel=preload; as=image; imagesrcset="${e}/link-srcset.png 1x, /own-origin.png 2x"` }),
    reported: [noted('Link header preload imagesrcset {E}/link-srcset.png on {APP}/...')],
    refused: true,
  },
  'Report-To with a repeated url key: every string in it counts': {
    headers: (e) => ({ 'report-to': `{"group":"g","max_age":600,"endpoints":[{"url":"${e}/repeated-key","url":"/own-origin"}]}` }),
    reported: [noted('report-to header sends reports to {E}/repeated-key, from {APP}/...')],
    refused: true,
  },
  // On an HTTPS page, a URL with the page's scheme and no "//" is a path on the page's origin when
  // read against its URL, and another host when read on its own, as the Reporting API reads an
  // endpoint (readingsOf).
  'Reporting-Endpoints on an HTTPS page, its endpoint https:host:port/x': {
    https: true,
    headers: (e) => ({ 'reporting-endpoints': `default="https:${new URL(e).host}/no-slash"` }),
    reported: [noted('reporting-endpoints header sends reports to {SE}/no-slash, from {SAPP}/...')],
    refused: true,
  },
  'Reporting-Endpoints on an HTTPS page, its endpoint https:/host:port/x': {
    https: true,
    headers: (e) => ({ 'reporting-endpoints': `default="https:/${new URL(e).host}/one-slash"` }),
    reported: [noted('reporting-endpoints header sends reports to {SE}/one-slash, from {SAPP}/...')],
    refused: true,
  },
  'Report-To on an HTTPS page, its endpoint https:host:port/x': {
    https: true,
    headers: (e) => ({
      'report-to': JSON.stringify({ group: 'g', max_age: 600, endpoints: [{ url: `https:${new URL(e).host}/no-slash` }] }),
      nel: '{"report_to":"g","max_age":600}',
    }),
    reported: [noted('report-to header sends reports to {SE}/no-slash, from {SAPP}/...')],
    refused: true,
  },
  'Report-To on an HTTPS page, its endpoint https:/host:port/x': {
    https: true,
    headers: (e) => ({
      'report-to': JSON.stringify({ group: 'g', max_age: 600, endpoints: [{ url: `https:/${new URL(e).host}/one-slash` }] }),
      nel: '{"report_to":"g","max_age":600}',
    }),
    reported: [noted('report-to header sends reports to {SE}/one-slash, from {SAPP}/...')],
    refused: true,
  },
  'CSP REPORT-URI, protocol-relative': {
    headers: (e) => ({ 'content-security-policy': `img-src 'none'; REPORT-URI //${new URL(e).host}/csp-protocol-relative` }),
    html: () => '<img src="/pixel">',
    reported: [noted('content-security-policy header sends reports to {E}/csp-protocol-relative, from {APP}/...')],
    refused: true,
  },
  // Switched off: keepalive and deferred requests, which go out even while, or after, the page closes.
  'fetchLater(), activateAfter: 0': {
    script: (e) => `fetchLater('${e}/later', { method: 'POST', body: 'x', activateAfter: 0 });`,
    reported: [off('fetchLater', '{E}/later')],
    refused: true,
  },
  'fetchLater(), sent when the page closes': {
    script: (e) => `fetchLater('${e}/later-on-close', { method: 'POST', body: 'x' });`,
    close: true,
    reported: [off('fetchLater', '{E}/later-on-close'), closed],
    refused: true,
  },
  'navigator.sendBeacon()': { script: (e) => `navigator.sendBeacon('${e}/beacon', 'x');`, reported: [off('navigator.sendBeacon', '{E}/beacon')], refused: true },
  'navigator.sendBeacon(), while the page closes': {
    script: (e) => `addEventListener('pagehide', () => navigator.sendBeacon('${e}/beacon-on-close', 'x'));`,
    close: true,
    reported: [off('navigator.sendBeacon', '{E}/beacon-on-close'), closed],
    refused: true,
  },
  'fetch() with keepalive': {
    script: (e) => `await fetch('${e}/keepalive', { method: 'POST', body: 'x', keepalive: true }).catch(() => {});`,
    reported: [off('fetch keepalive', '{E}/keepalive')],
    refused: true,
  },
  'fetch() of a keepalive Request, while the page closes': {
    script: (e) => `addEventListener('pagehide', () => { fetch(new Request('${e}/keepalive-on-close', { method: 'POST', body: 'x', keepalive: true })).catch(() => {}); });`,
    close: true,
    reported: [off('fetch keepalive', '{E}/keepalive-on-close'), closed],
    refused: true,
  },
  // Switched off: other sockets and worklets.
  'WebSocketStream': { script: (e) => `new WebSocketStream('${e.replace('http:', 'ws:')}/stream');`, reported: [off('WebSocketStream', '{WS}/stream')], refused: true },
  'CSS paint worklet': { script: (e) => `await CSS.paintWorklet.addModule('${e}/paint.js');`, reported: [off('Worklet', '{E}/paint.js')], refused: true },
  'Shared Storage writes': {
    script: () => each(["sharedStorage.set('k', 'v')", "sharedStorage.append('k', 'w')", "sharedStorage.delete('k')"]),
    reported: [off('sharedStorage.set', 'k'), off('sharedStorage.append', 'k'), off('sharedStorage.delete', 'k')],
    refused: true,
  },
  'Shared Storage worklets': {
    script: (e) => each([`sharedStorage.worklet.addModule('${e}/shared-storage.js')`, `sharedStorage.createWorklet('${e}/shared-storage-2.js')`,
      "sharedStorage.run('operation')", "sharedStorage.selectURL('operation', [{ url: '/stay' }])"]),
    reported: [off('sharedStorage.worklet.addModule', '{E}/shared-storage.js'), off('sharedStorage.createWorklet', '{E}/shared-storage-2.js'),
      off('sharedStorage.run', 'operation'), off('sharedStorage.selectURL', 'operation')],
    refused: true,
  },
  // Switched off: APIs whose fetches the browser makes itself.
  'Protected Audience': {
    script: (e) => `${each([
      `navigator.joinAdInterestGroup({ owner: '${e}', name: 'g', biddingLogicURL: '${e}/bid.js', lifetimeMs: 60000 })`,
      `navigator.runAdAuction({ seller: '${e}', decisionLogicURL: '${e}/decide.js', interestGroupBuyers: ['${e}'] })`,
      `navigator.leaveAdInterestGroup({ owner: '${e}', name: 'g' })`,
      `navigator.clearOriginJoinedAdInterestGroups('${e}')`,
      `navigator.getInterestGroupAdAuctionData({ seller: '${e}' })`,
      'navigator.createAuctionNonce()',
      "navigator.deprecatedURNToURL('urn:uuid:x')",
      "navigator.deprecatedReplaceInURN('urn:uuid:x', {})",
    ])}\ntry { navigator.updateAdInterestGroups(); } catch {}`,
    reported: [
      off('navigator.joinAdInterestGroup', '{"owner":"{E}",...'), off('navigator.runAdAuction', '{"seller":"{E}",...'),
      off('navigator.leaveAdInterestGroup', '{"owner":"{E}",...'), off('navigator.clearOriginJoinedAdInterestGroups', '{E}'),
      off('navigator.getInterestGroupAdAuctionData', '{"seller":"{E}"}'), off('navigator.createAuctionNonce', '...'),
      off('navigator.deprecatedURNToURL', 'urn:uuid:x'), off('navigator.deprecatedReplaceInURN', 'urn:uuid:x'),
      off('navigator.updateAdInterestGroups', '...'),
    ],
    refused: true,
  },
  'navigator.credentials and FedCM': {
    script: (e) => `${each([
      `navigator.credentials.get({ identity: { providers: [{ configURL: '${e}/fedcm.json', clientId: 'x' }] } })`,
      'navigator.credentials.create({ publicKey: {} })',
      'navigator.credentials.store(null)',
      'navigator.credentials.preventSilentAccess()',
      `IdentityCredential.disconnect({ configURL: '${e}/fedcm.json', clientId: 'x', accountHint: 'a' })`,
      `IdentityProvider.getUserInfo({ configURL: '${e}/fedcm.json', clientId: 'x' })`,
      "IdentityProvider.resolve('token')",
    ])}\ntry { IdentityProvider.close(); } catch {}`,
    reported: [
      off('navigator.credentials.get', '{"identity":{"providers":[{"configURL":"{E}/fedcm.json",...'), off('navigator.credentials.create', '...'),
      off('navigator.credentials.store', '...'), off('navigator.credentials.preventSilentAccess', '...'),
      off('IdentityCredential.disconnect', '{"configURL":"{E}/fedcm.json",...'), off('IdentityProvider.getUserInfo', '{"configURL":"{E}/fedcm.json",...'),
      off('IdentityProvider.resolve', 'token'), off('IdentityProvider.close', '...'),
    ],
    refused: true,
  },
  'Payment Request': {
    script: (e) => `new PaymentRequest([{ supportedMethods: '${e}/pay' }], { total: { label: 't', amount: { currency: 'USD', value: '1' } } });`,
    reported: [off('PaymentRequest', '[{"supportedMethods":"{E}/pay"}]')],
    refused: true,
  },
  'Presentation API': { script: (e) => `new PresentationRequest(['${e}/present']);`, reported: [off('PresentationRequest', '["{E}/present"]')], refused: true },
  'Notification': { script: (e) => `new Notification('title', { icon: '${e}/notification-icon' });`, reported: [off('Notification', 'title')], refused: true },
  'geolocation': {
    script: () => 'try { navigator.geolocation.getCurrentPosition(() => {}); } catch {}\ntry { navigator.geolocation.watchPosition(() => {}); } catch {}',
    reported: [off('geolocation.getCurrentPosition', '...'), off('geolocation.watchPosition', '...')],
    refused: true,
  },
  'speech recognition and synthesis': {
    script: () => "try { new SpeechRecognition(); } catch {}\ntry { new webkitSpeechRecognition(); } catch {}\ntry { speechSynthesis.speak('x'); } catch {}",
    reported: [off('SpeechRecognition', '...'), off('webkitSpeechRecognition', '...'), off('speechSynthesis.speak', '...')],
    refused: true,
  },
  'built-in AI models': {
    script: () => each(['Translator', 'LanguageDetector', 'Summarizer'].map((api) => `${api}.create({ sourceLanguage: 'en', targetLanguage: 'fr' })`)),
    reported: [off('Translator.create', '...'), off('LanguageDetector.create', '...'), off('Summarizer.create', '...')],
    refused: true,
  },
  'navigator.getInstalledRelatedApps()': { script: () => each(['navigator.getInstalledRelatedApps()']), reported: [off('navigator.getInstalledRelatedApps', '...')], refused: true },
  'document.open() with three arguments': { script: (e) => `document.open('${e}/document-open', '', '');`, reported: [off('document.open', '{E}/document-open')], refused: true },
  'Document Picture-in-Picture': {
    script: () => each(['documentPictureInPicture.requestWindow()']),
    activate: true,
    reported: [off('documentPictureInPicture.requestWindow', '...')],
    refused: true,
  },
  // Not network-capable in this build: nothing to report, and nothing reaches the other origin.
  '<link rel=icon>: this build fetches no icon': { html: (e) => `<link rel="icon" href="${e}/icon">`, reported: [], refused: true },
  '<link rel=manifest>: this build fetches no manifest': { html: (e) => `<link rel="manifest" href="${e}/manifest.json">`, reported: [], refused: true },
  'Early Hints: not processed over HTTP/1.1': { earlyHints: (e) => ({ link: [`<${e}/early-hints>; rel=preload; as=image`, `<${e}>; rel=preconnect`] }), reported: [], refused: true },
  '<meta http-equiv=content-security-policy>: report-uri is ignored, and report-to has no endpoint without a header': {
    html: (e) => `<meta http-equiv="content-security-policy" content="img-src 'none'; report-uri ${e}/meta-csp">`
      + '<meta http-equiv="content-security-policy" content="img-src \'none\'; report-to meta-group">',
    script: () => "const image = new Image(); image.src = '/pixel'; document.body.append(image);",
    reported: [],
    refused: true,
  },
  'BroadcastChannel: within the browser': { script: () => "const channel = new BroadcastChannel('c'); channel.postMessage('x');", reported: [], refused: true },
  'navigator.connection: read locally': { script: () => 'void navigator.connection.effectiveType;', reported: [], refused: true },
  'requestStorageAccess(): a permission': { script: () => each(['document.requestStorageAccess()', "document.requestStorageAccessFor('https://example.com')"]), reported: [], refused: true },
  'Topics: computed in the browser': { script: () => each(['document.browsingTopics()']), reported: [], refused: true },
  'Private State Tokens: no key commitments in this build': { script: (e) => each([`document.hasPrivateToken('${e}')`, `document.hasRedemptionRecord('${e}')`]), reported: [], refused: true },
  'MediaSource: fed by the page': { script: () => "const video = document.createElement('video'); video.src = URL.createObjectURL(new MediaSource());", reported: [], refused: true },
};

/** APIs the coverage review found absent from this build, each as an expression true when present. */
const ABSENT: Record<string, string> = {
  'showModalDialog': "'showModalDialog' in window",
  '<portal>': "'HTMLPortalElement' in window",
  'CSS animation and layout worklets': "'animationWorklet' in CSS || 'layoutWorklet' in CSS",
  'Web Share': "'share' in navigator || 'canShare' in navigator",
  'Web NFC': "'NDEFReader' in window",
  'Contact Picker': "'contacts' in navigator",
  'Prompt API and writing assistance': "['LanguageModel', 'Writer', 'Rewriter', 'Proofreader'].some((name) => name in window)",
  'fenced frame configs from a URL (only runAdAuction and sharedStorage.selectURL, both off, make one)': "(() => { try { new FencedFrameConfig('/x'); return true; } catch { return false; } })()",
  'standalone ICE transports (only through RTCPeerConnection, which is off)': '(() => { try { new RTCIceTransport(); return true; } catch { return false; } })()',
  'the Widevine CDM, whose provisioning the browser would fetch': `navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }]).then(() => true, () => false)`,
  'OpenSearch descriptions (<link rel=search>)': "document.createElement('link').relList.supports('search')",
};

/** The browser's surface: every global, the members of the interfaces that load anything, and the feature switches. */
function browserSurface() {
  const own = (object: unknown) => (object ? Object.getOwnPropertyNames(object).sort() : null);
  const globals = new Set<string>();
  for (let object: object | null = globalThis; object && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
    for (const name of Object.getOwnPropertyNames(object)) globals.add(name);
  }
  const named = globalThis as unknown as Record<string, { prototype?: object } | undefined>;
  const interfaces = ['Navigator', 'Document', 'Element', 'HTMLElement', 'HTMLAnchorElement', 'HTMLAreaElement', 'HTMLImageElement', 'HTMLLinkElement',
    'HTMLScriptElement', 'HTMLIFrameElement', 'HTMLFencedFrameElement', 'HTMLMediaElement', 'HTMLFormElement', 'HTMLObjectElement', 'HTMLEmbedElement',
    'ServiceWorkerContainer', 'ServiceWorkerRegistration', 'Worklet', 'SharedStorage', 'SharedStorageWorklet', 'CredentialsContainer', 'Cache', 'Request'];
  const link = document.createElement('link');
  const policy = (document as unknown as { featurePolicy?: { features: () => string[] } }).featurePolicy;
  return {
    globals: [...globals].sort(),
    css: own(CSS),
    statics: Object.fromEntries(['IdentityCredential', 'IdentityProvider', 'Translator', 'LanguageDetector', 'Summarizer', 'PublicKeyCredential']
      .map((name) => [name, own(named[name])])),
    interfaces: Object.fromEntries(interfaces.map((name) => [name, own(named[name]?.prototype)])),
    scriptTypes: Object.fromEntries(['classic', 'module', 'importmap', 'speculationrules', 'webbundle'].map((type) => [type, HTMLScriptElement.supports(type)])),
    linkRels: Object.fromEntries(['preload', 'prefetch', 'modulepreload', 'preconnect', 'dns-prefetch', 'prerender', 'compression-dictionary', 'icon', 'manifest',
      'search', 'serviceworker', 'expect', 'payment'].map((rel) => [rel, link.relList.supports(rel)])),
    permissionsPolicyFeatures: policy?.features().sort() ?? null,
  };
}

let app: Recorder;
/** The same app over HTTPS. */
let secureApp: Recorder;
let elsewhere: Elsewhere;

/**
 * A page that puts a URL with the page's scheme and no "//" (`https:host:port/x` and
 * `https:/host:port/x`, the host and port the other origin's) in each place the guard reads one.
 */
const SCHEMED_URLS: Pick<Row, 'headers' | 'html'> = {
  headers: (e) => {
    const host = new URL(e).host;
    return {
      'content-security-policy': `img-src 'none'; report-uri https:${host}/csp-0 https:/${host}/csp-1`,
      link: `<https:${host}/link-0>; rel=preload; as=image, <https:/${host}/link-1>; rel=preload; as=image`,
      'speculation-rules': `"https:${host}/rules-0.json", "https:/${host}/rules-1.json"`,
      'reporting-endpoints': `zero="https:${host}/endpoint-0", one="https:/${host}/endpoint-1"`,
    };
  },
  html: (e) => {
    const host = new URL(e).host;
    return `<link id="hint-0" rel="preconnect" href="https:${host}/hint-0"><link id="hint-1" rel="preconnect" href="https:/${host}/hint-1">`
      + '<img src="/pixel">';
  },
};

test.beforeAll(async () => {
  elsewhere = await elsewhereServer();
  const reached: string[] = [];
  const serve: http.RequestListener = (req, res) => {
    reached.push(req.url ?? '');
    const url = new URL(req.url ?? '/', 'http://app.invalid');
    if (url.pathname === '/pixel') {
      res.writeHead(200, { 'content-type': 'image/gif' });
      return res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
    }
    if (url.pathname !== '/') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    const row: Partial<Row> | undefined = url.searchParams.has('schemed-urls') ? SCHEMED_URLS : ROWS[url.searchParams.get('row') ?? ''];
    const script = row?.script?.(elsewhere.url) ?? '';
    const run = row?.activate
      ? `<button id="go">go</button><script type="module">document.getElementById('go').onclick = async () => { ${script} };</script>`
      : `<script type="module">try { ${script} } catch {}</script>`;
    const respond = () => {
      res.writeHead(200, { 'content-type': 'text/html', ...row?.headers?.(elsewhere.url) });
      res.end(`<!doctype html><html><head><title>row</title></head><body>${row?.html?.(elsewhere.url) ?? ''}${run}</body></html>`);
    };
    if (!row?.earlyHints) return respond();
    res.writeEarlyHints(row.earlyHints(elsewhere.url));
    setTimeout(respond, 300);
  };
  const server = http.createServer(serve);
  app = { url: await listen(server), reached, close: closeServer(server) };
  const secureServer = https.createServer(selfSignedCertificate(), serve);
  secureApp = { url: await listen(secureServer), reached, close: closeServer(secureServer) };
});

test.afterAll(async () => {
  await app?.close();
  await secureApp?.close();
  await elsewhere?.close();
});

for (const [name, row] of Object.entries(ROWS)) {
  const verdict = row.reported.length > 0 ? 'the guard reports it' : 'not network-capable here: nothing to report';
  test(`${name}: ${verdict}${row.refused ? ', and nothing reaches the other origin' : ''}`, async ({ browser }) => {
    elsewhere.reset();
    const origin = row.https ? secureApp.url : app.url;
    const context = await browser.newContext({ ignoreHTTPSErrors: row.https === true });
    try {
      const guard = await watchOrigin(context, origin);
      const page = await context.newPage();
      await guard.watch(page);
      await page.goto(`${origin}/?row=${encodeURIComponent(name)}`);
      if (row.click) await page.click(row.click);
      if (row.activate) await page.click('#go');
      // Long enough for anything not stopped to get through.
      await page.waitForTimeout(1200);
      if (row.close) {
        await page.close();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (row.reported.length > 0) {
        await expect.poll(() => guard.foreign).toEqual(expect.arrayContaining(row.reported.map((expected) => expect.stringMatching(expected))));
        await expect(expectNoForeignTraffic(guard), 'a test under the guard fails').rejects.toThrow(/traffic to an origin other than/);
      } else {
        await expectNoForeignTraffic(guard);
      }
      if (row.refused) {
        expect(elsewhere.reached, 'what reached the other origin').toEqual([]);
        expect(elsewhere.connections(), 'connections to the other origin').toBe(0);
      }
    } finally {
      await context.close();
    }
  });
}

test('a context\'s close runs no unload handlers, so the pages a test leaves open send nothing as they close', async ({ browser }) => {
  elsewhere.reset();
  const context = await browser.newContext();
  const guard = await watchOrigin(context, app.url);
  const page = await context.newPage();
  await guard.watch(page);
  await page.goto(`${app.url}/?row=${encodeURIComponent('a request while the page closes')}`);
  await context.close();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(elsewhere.reached).toEqual([]);
  expect(elsewhere.connections()).toBe(0);
});

test('on an HTTPS page, the browser reads https:host:port/x and https:/host:port/x as paths, except as Reporting API endpoints, and the guard reports each', async ({ browser }) => {
  elsewhere.reset();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const guard = await watchOrigin(context, secureApp.url);
    const page = await context.newPage();
    await guard.watch(page);
    // The Reporting API's endpoints, as the browser itself reads them.
    const endpoints: string[] = [];
    const session = await context.newCDPSession(page);
    session.on('Network.reportingApiEndpointsChangedForOrigin', (event) => endpoints.push(...event.endpoints.map((endpoint) => endpoint.url)));
    await session.send('Network.enable');
    await session.send('Network.enableReportingApi', { enable: true });
    await page.goto(`${secureApp.url}/?schemed-urls`);
    const other = new URL(elsewhere.url).host;
    const asPath = (name: string) => `${secureApp.url}/${other}/${name}`;
    const alone = (name: string) => `https://${other}/${name}`;
    // Against the page's URL: a CSP report-uri, a Link target, a Speculation-Rules URL, a link's href.
    await expect.poll(() => guard.requests.map((request) => request.url))
      .toEqual(expect.arrayContaining(['csp-0', 'csp-1', 'link-0', 'link-1', 'rules-0.json', 'rules-1.json'].map(asPath)));
    expect(await page.evaluate(() => ['hint-0', 'hint-1'].map((id) => (document.getElementById(id) as HTMLLinkElement).href)))
      .toEqual(['hint-0', 'hint-1'].map(asPath));
    // On their own: the Reporting API's endpoints.
    await expect.poll(() => endpoints).toEqual(expect.arrayContaining(['endpoint-0', 'endpoint-1'].map(alone)));
    // The guard reads each URL both ways (readingsOf), so it reports each.
    await expect.poll(() => guard.foreign).toEqual(expect.arrayContaining([
      ...['endpoint-0', 'endpoint-1'].map((name) => expect.stringContaining(`reporting-endpoints header sends reports to ${alone(name)},`)),
      ...['csp-0', 'csp-1'].map((name) => expect.stringContaining(`content-security-policy header sends reports to ${alone(name)},`)),
      ...['link-0', 'link-1'].map((name) => expect.stringContaining(`Link header preload ${alone(name)} on`)),
      ...['hint-0', 'hint-1'].map((name) => expect.stringContaining(`link hint preconnect ${alone(name)} (`)),
      expect.stringContaining('Speculation-Rules header'),
    ]));
    expect(elsewhere.reached).toEqual([]);
    expect(elsewhere.connections()).toBe(0);
  } finally {
    await context.close();
  }
});

/** APIs the guarded browser runs without (DISABLED_BLINK_FEATURES), each as an expression true when present. */
const REMOVED_AT_LAUNCH: Record<string, string> = {
  'fetchLater (FetchLaterAPI)': "'fetchLater' in window",
  'WebSocketStream': "'WebSocketStream' in window",
  'SharedWorker': "'SharedWorker' in window",
  'Shared Storage (SharedStorageAPI)': "'sharedStorage' in window || 'SharedStorageWorklet' in window",
  'Protected Audience (AdInterestGroupAPI, Fledge)': "['joinAdInterestGroup', 'leaveAdInterestGroup', 'updateAdInterestGroups', 'runAdAuction', 'getInterestGroupAdAuctionData', 'createAuctionNonce'].some((name) => name in navigator)",
  'fenced frames (FencedFrames)': "'HTMLFencedFrameElement' in window",
  'FedCM (FedCm)': "'IdentityCredential' in window || 'IdentityProvider' in window",
  'WebOTP': "'OTPCredential' in window",
  'Document Picture-in-Picture (DocumentPictureInPictureAPI)': "'documentPictureInPicture' in window",
  'Presentation API (Presentation)': "'PresentationRequest' in window",
  'Notification (Notifications)': "'Notification' in window",
  'speech recognition (ScriptedSpeechRecognition)': "'webkitSpeechRecognition' in window",
  'speech synthesis (ScriptedSpeechSynthesis)': "'speechSynthesis' in window",
  'built-in AI (TranslationAPI, LanguageDetectionAPI, AISummarizationAPI)': "['Translator', 'LanguageDetector', 'Summarizer'].some((name) => name in window)",
  'getInstalledRelatedApps (InstalledApp)': "'getInstalledRelatedApps' in navigator",
  'background fetch, periodic sync, push (BackgroundFetch, PeriodicBackgroundSync, PushMessaging)': "['BackgroundFetchManager', 'PeriodicSyncManager', 'PushManager'].some((name) => name in window)",
};

test('the APIs removed at launch are gone where no init script runs', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${app.url}/blank`);
    for (const [api, present] of Object.entries(REMOVED_AT_LAUNCH)) {
      expect(await page.evaluate(present), api).toBe(false);
    }
  } finally {
    await context.close();
  }
});

test('the APIs the inventory lists as not in this build are not in it', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${app.url}/blank`);
    for (const [api, present] of Object.entries(ABSENT)) {
      expect(await page.evaluate(present), api).toBe(false);
    }
  } finally {
    await context.close();
  }
});

// Fails when a browser update adds or removes any API: review the difference against
// the rows of this file, then record the new surface with --update-snapshots.
const SURFACE_TEST = 'this build\'s API surface is the one this coverage table was reviewed against';

test(SURFACE_TEST, async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${app.url}/blank`);
    const surface = { browser: browser.version(), ...await page.evaluate(browserSurface) };
    expect(`${JSON.stringify(surface, null, 1)}\n`).toMatchSnapshot('browser-surface.json');
  } finally {
    await context.close();
  }
});

test('on a platform with no recorded surface, every run fails and none records one', async () => {
  test.setTimeout(180_000);
  const web = fileURLToPath(new URL('..', import.meta.url));
  const dir = test.info().outputPath('no-baseline');
  const snapshots = path.join(dir, 'snapshots');
  const config = path.join(dir, 'playwright.config.ts');
  await mkdir(dir, { recursive: true });
  // The harness config itself, with its snapshots somewhere that has none.
  await writeFile(config, [
    `import harness from ${JSON.stringify(path.join(web, 'playwright.harness.config.ts'))};`,
    `export default { ...harness, testDir: ${JSON.stringify(path.join(web, 'tests'))}, outputDir: ${JSON.stringify(path.join(dir, 'results'))},`,
    `  snapshotPathTemplate: ${JSON.stringify(`${snapshots}/{arg}{-snapshotSuffix}{ext}`)} };`,
  ].join('\n'));
  // This run's own settings stay out of the nested one.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(TEST_|PW_|PLAYWRIGHT_TEST|NODE_OPTIONS$)/.test(name)));
  for (const run of [1, 2]) {
    const result = spawnSync(process.execPath, [createRequire(import.meta.url).resolve('@playwright/test/cli'), 'test', '-c', config, 'origin-guard-coverage', '-g', SURFACE_TEST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], {
      cwd: web, env, encoding: 'utf8', timeout: 120_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, `run ${run}: ${output.slice(-600)}`).not.toBe(0);
    expect(output, `run ${run}`).toMatch(/1 failed/);
    expect(output, `run ${run}`).toContain("A snapshot doesn't exist");
    expect(existsSync(snapshots), `run ${run} recorded a surface`).toBe(false);
  }
});
