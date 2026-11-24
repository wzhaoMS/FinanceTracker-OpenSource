import assert from 'node:assert/strict';
import test from 'node:test';

import { REMOVED_LAN_SETTINGS, removedLanMessage, removedLanSetting, resolveLanHttpsConfig } from './lanHttps.js';

test('the removed LAN modes: every setting that asks for one is named, and only HOLDR_LAN_HTTP has an off value', () => {
  for (const env of [{}, { HOLDR_LAN_HTTP: '0' }, { HOLDR_LAN_HTTP: '' }, { HOLDR_HOST: '127.0.0.1', HOLDR_WEB_MODE: 'vite' }]) {
    assert.equal(removedLanSetting(env), null, JSON.stringify(env));
    assert.equal(resolveLanHttpsConfig(env), null, JSON.stringify(env));
  }
  for (const [name, value] of [['HOLDR_LAN_HTTP', '1'], ['HOLDR_LAN_HTTP', 'yes'], ...REMOVED_LAN_SETTINGS.slice(1)
    .flatMap((key) => [[key, '192.0.2.10'], [key, '']])]) {
    assert.equal(removedLanSetting({ HOLDR_WEB_MODE: 'vite', [name]: value }), name, `${name}=${value}`);
    assert.throws(() => resolveLanHttpsConfig({ [name]: value }), (error: Error & { code?: string }) => error.code === 'E0I_LAN_REMOVED'
      && error.message === `E0I_LAN_REMOVED: ${removedLanMessage(name)}`, `${name}=${value}`);
  }
});

test('the refusal says what to do instead and names no value', () => {
  const message = removedLanMessage('HOLDR_LAN_HTTPS_KEY');
  assert.match(message, /^HOLDR_LAN_HTTPS_KEY is no longer supported: .*LAN modes were removed.*Tailscale Serve/);
  assert.throws(() => resolveLanHttpsConfig({ HOLDR_LAN_HTTPS_KEY: '/private/synthetic/leaf-key.pem' }),
    (error: Error) => !error.message.includes('/private/synthetic'));
});