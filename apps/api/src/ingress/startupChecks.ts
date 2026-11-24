import { WebReleaseError } from '@finance-tracker/shared/web-release';
import { loadWebRelease } from './webRelease.js';
import type { IngressConfig, ReleaseIngressConfig } from './config.js';
import type { SocketSafety } from './server.js';
import type { IngressAdmission, ListenerConfig, WebIngressOptions } from './types.js';

/**
 * A2 supplies socket/attestation components. PR B still owns trusted configuration,
 * lifecycle acquisition before opening the DB, and data/control isolation checks.
 * It must not be replaced with an environment-controlled "verified" flag.
 */
export interface IngressRuntimeIntegration {
  readonly admission: IngressAdmission;
  readonly socketSafety: SocketSafety;
  beforeDatabaseOpen(config: ReleaseIngressConfig): Promise<void>;
}

export interface PreparedIngress {
  readonly web: WebIngressOptions;
  readonly listeners: readonly ListenerConfig[];
  readonly socketSafety?: SocketSafety;
}

export async function prepareIngress(config: IngressConfig, integration?: IngressRuntimeIntegration): Promise<PreparedIngress> {
  if (config.mode === 'dev') {
    return { web: { mode: 'dev' }, listeners: [{ mode: 'dev', listener: 'local', host: config.host, port: config.port }] };
  }
  // Release/configuration failures are actionable even before the production integration ships.
  const release = loadWebRelease({ dir: config.releaseDir, digest: config.releaseDigest });
  if (!integration || typeof integration.beforeDatabaseOpen !== 'function') throw new WebReleaseError('E0I_RUNTIME_UNAVAILABLE');
  await integration.beforeDatabaseOpen(config);
  const { admission, socketSafety } = integration;
  if (config.mode === 'dist') {
    return {
      web: { mode: 'dist', release, publicOrigin: config.publicOrigin, admission },
      listeners: [
        { mode: 'dist', listener: 'ingress', publicOrigin: config.publicOrigin, socketPath: config.socketPath, admission },
        { mode: 'dist', listener: 'local', publicOrigin: config.publicOrigin, port: config.port, admission },
      ],
      socketSafety,
    };
  }
  return {
    web: { mode: 'local', release, ingressPort: config.ingressPort, admission },
    listeners: [
      { mode: 'local', listener: 'ingress', port: config.ingressPort, admission },
      { mode: 'local', listener: 'local', port: config.port, admission },
    ],
  };
}
