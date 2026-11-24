// Types for codeIdentity.mjs (card-upload migration B-a), which stays plain JavaScript: the uploader's admission gate
// loads it before anything else is verified, with Node builtins only. release/apiAttestation.test.ts checks that every
// export of the module is declared here.

export declare const CODE_IDENTITY_ALGORITHM: 'holdr.api-code-identity/1';
export declare const CODE_IDENTITY_TREES: readonly string[];
export declare const CODE_IDENTITY_FILES: readonly string[];
export declare const LOCKFILES: readonly string[];
export declare const NATIVE_ADDON: string;
export declare const API_ATTESTATION_PATH: '/release/attestation';
export declare const ATTESTATION_FORMAT: 'holdr.api-release-attestation';
export declare const ATTESTATION_VERSION: 1;
export declare const MAX_ATTESTATION_BYTES: number;

/** A value-free refusal: `code` is a fixed token; `detail` (a path, when there is one) is never shown. */
export declare class CodeIdentityError extends Error {
  constructor(code: string, detail?: string | null);
  code: string;
  detail: string | null;
}

/** [path relative to the live root, sha256, or null for an absent single file]. */
export type CodeIdentityEntry = [string, string | null];

export interface CodeIdentity {
  algorithm: typeof CODE_IDENTITY_ALGORITHM;
  digest: string;
  entries: CodeIdentityEntry[];
}

export interface RuntimeIdentity {
  execPath: string;
  version: string;
  sha256: string;
}

export interface ApiAttestationInput {
  pid: number;
  startedAt: number | string | Date;
  execPath: string;
  version: string;
  execArgv: readonly string[];
  cwd: string;
  entry: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
  liveRoot: string;
}

/** Exactly what GET /release/attestation serves. */
export interface ApiReleaseAttestation {
  readonly format: typeof ATTESTATION_FORMAT;
  readonly version: typeof ATTESTATION_VERSION;
  readonly pid: number;
  readonly startedAt: string;
  readonly runtime: Readonly<RuntimeIdentity>;
  readonly entry: string;
  readonly preloads: readonly string[];
  readonly flags: readonly string[];
  readonly nodeOptions: boolean;
  readonly code: Readonly<{ algorithm: typeof CODE_IDENTITY_ALGORITHM; digest: string }>;
}

export declare function compareText(a: string, b: string): number;
export declare function sha256Hex(bytes: string | NodeJS.ArrayBufferView): string;
export declare function sha256File(file: string): string;
export declare function codeIdentityEntries(liveRoot: string): CodeIdentityEntry[];
export declare function codeIdentityDigest(entries: readonly (readonly [string, string | null])[]): string;
export declare function computeCodeIdentity(liveRoot: string): CodeIdentity;
export declare function runtimeIdentity(execPath: string, version: string): RuntimeIdentity;
export declare function describeExecArgv(execArgv: readonly string[], cwd: string): { preloads: string[]; flags: string[] };
export declare function createApiAttestation(input: ApiAttestationInput): ApiReleaseAttestation;
export declare function parseApiAttestation(value: unknown): ApiReleaseAttestation;
