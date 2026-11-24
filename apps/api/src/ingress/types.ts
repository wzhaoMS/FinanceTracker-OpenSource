import type { WebRelease } from './webRelease.js';
import type { ParsedIngressTarget } from './requestTarget.js';

export type IngressMode = 'dev' | 'dist' | 'local';
export type IngressRefusal = 'ingress-unverified' | 'ingress-refused';

/** PR B supplies a live, per-request attestation decision. No environment flag can grant admission. */
export interface IngressAdmission {
  refusal(): IngressRefusal | null;
}

export const CLOSED_ADMISSION: IngressAdmission = Object.freeze({
  refusal: () => 'ingress-unverified' as const,
});

export function admissionRefusal(admission?: IngressAdmission): IngressRefusal | null {
  try {
    const result = (admission ?? CLOSED_ADMISSION).refusal();
    return result === null || result === 'ingress-refused' ? result : 'ingress-unverified';
  } catch {
    return 'ingress-unverified';
  }
}

export interface HoldrIngressFacts {
  readonly listener: 'local' | 'ingress';
  readonly mode: IngressMode;
  readonly profile: 'dev' | 'direct' | 'serve' | 'local-browser';
  readonly clientAddress: string;
}

export type WebIngressOptions =
  | { readonly mode: 'dev' }
  | { readonly mode: 'dist'; readonly publicOrigin: string; readonly release: WebRelease; readonly admission?: IngressAdmission }
  | { readonly mode: 'local'; readonly ingressPort: number; readonly release: WebRelease; readonly admission?: IngressAdmission };

export type ListenerConfig =
  | { readonly mode: 'dev'; readonly listener: 'local'; readonly port: number; readonly host?: string }
  | { readonly mode: 'dist'; readonly listener: 'ingress'; readonly publicOrigin: string; readonly socketPath: string; readonly admission?: IngressAdmission }
  | { readonly mode: 'dist'; readonly listener: 'local'; readonly publicOrigin: string; readonly port: number; readonly admission?: IngressAdmission }
  | { readonly mode: 'local'; readonly listener: 'local' | 'ingress'; readonly port: number; readonly admission?: IngressAdmission };

declare module 'node:http' {
  interface IncomingMessage {
    readonly holdrIngress?: HoldrIngressFacts;
    holdrTarget?: ParsedIngressTarget;
    holdrRefusalLog?: (code: string, method: string) => void;
  }
}
