import type { Router } from 'express';
import { createVerifiedRouter } from '../../ingress/expressIdentity.js';
import type { AuthorizationFenceContext } from '../../control/authorizationChange.js';
import type { DeviceAdmission } from '../../ingress/deviceAdmission.js';
import { createCardSyncDeviceRouter, type CardSyncDeviceOptions } from './device.js';
import { DeviceHttpError } from './deviceProtocol.js';

export interface PendingDeviceMount {
  readonly router: Router;
  install(admission: DeviceAdmission, authorization: AuthorizationFenceContext): void;
}

/** Reserve the pre-identify position without constructing a device route before the dist socket exists (D-D1). */
export function createPendingDeviceMount(
  options: Pick<CardSyncDeviceOptions, 'repo' | 'holdrOrigin' | 'log'>,
): PendingDeviceMount {
  const router = createVerifiedRouter();
  let installed = false;
  return Object.freeze({
    router,
    install(admission: DeviceAdmission, authorization: AuthorizationFenceContext) {
      if (installed) throw new DeviceHttpError(500, 'internal-error');
      const device = createCardSyncDeviceRouter({ ...options, admission, authorization });
      router.use(device);
      installed = true;
    },
  });
}
