import { createHash } from 'node:crypto';

import { fail } from './errors.js';
import type { Runner } from './runner.js';

const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

/** `"IOPlatformUUID" = "<UUID>"` from `ioreg -rd1 -c IOPlatformExpertDevice`; exactly one. */
export function parsePlatformUuid(text: string): string | null {
  const matches = [...text.matchAll(/^\s*"IOPlatformUUID" = "([^"\n]*)"\s*$/gm)];
  return matches.length === 1 && UUID.test(matches[0][1]) ? matches[0][1] : null;
}

/** The mount point column of `df -P <path>` (it may contain spaces). */
export function parseMountPoint(text: string): string | null {
  const lines = text.split('\n').filter(Boolean);
  if (lines.length !== 2 || !lines[0].startsWith('Filesystem')) return null;
  const match = /^\S+\s+\d+\s+\d+\s+\d+\s+\d+%\s+(\/.*)$/.exec(lines[1]);
  return match ? match[1] : null;
}

/** `<key>VolumeUUID</key><string>UUID</string>` from `diskutil info -plist`; exactly one. */
export function parseVolumeUuid(text: string): string | null {
  const matches = [...text.matchAll(/<key>VolumeUUID<\/key>\s*<string>([^<]*)<\/string>/g)];
  return matches.length === 1 && UUID.test(matches[0][1]) ? matches[0][1] : null;
}

/** First 16 hex digits of SHA-256(IOPlatformUUID ‖ VolumeUUID) (§9.2). */
export function machineIdFrom(platformUuid: string, volumeUuid: string): string {
  return createHash('sha256').update(platformUuid + volumeUuid).digest('hex').slice(0, 16);
}

/**
 * The running machine's `machine` value for the volume holding `volumePath` (the data dir). Read-only system queries; any
 * failure is `E0I_MACHINE_ID`, which keeps the device gate closed (a fence can never match an unknown machine).
 */
export async function computeMachineId(run: Runner, volumePath: string): Promise<string> {
  const ioreg = await run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
  const platform = ioreg.exitCode === 0 ? parsePlatformUuid(ioreg.stdout) : null;
  if (!platform) return fail('E0I_MACHINE_ID', 'ioreg');
  const df = await run('/bin/df', ['-P', volumePath]);
  const mount = df.exitCode === 0 ? parseMountPoint(df.stdout) : null;
  if (!mount) return fail('E0I_MACHINE_ID', 'df');
  const info = await run('/usr/sbin/diskutil', ['info', '-plist', mount]);
  const volume = info.exitCode === 0 ? parseVolumeUuid(info.stdout) : null;
  if (!volume) return fail('E0I_MACHINE_ID', 'diskutil');
  return machineIdFrom(platform, volume);
}
