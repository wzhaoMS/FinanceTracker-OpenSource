import { describe, expect, it } from 'vitest';

import { systemRunner } from './exec.js';
import { computeMachineId, machineIdFrom, parseMountPoint, parsePlatformUuid, parseVolumeUuid } from './machineId.js';
import type { Runner } from './runner.js';

const PLATFORM = '11111111-2222-3333-4444-555555555555';
const VOLUME = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const IOREG = `+-o Mac  <class IOPlatformExpertDevice>\n    {\n      "IOPlatformSerialNumber" = "N"\n      "IOPlatformUUID" = "${PLATFORM}"\n    }\n`;
const DF = 'Filesystem   512-blocks      Used Available Capacity  Mounted on\n/dev/disk1s1  976490576 811422792 117710152    88%    /System/Volumes/Data\n';
const PLIST = `<plist><dict><key>VolumeName</key><string>Data</string><key>VolumeUUID</key>\n\t<string>${VOLUME}</string></dict></plist>`;

describe('machine id (§9.2)', () => {
  it('parses exactly one platform UUID, mount point and volume UUID', () => {
    expect(parsePlatformUuid(IOREG)).toBe(PLATFORM);
    expect(parsePlatformUuid(IOREG + IOREG)).toBeNull();
    expect(parsePlatformUuid(IOREG.replace(PLATFORM, 'not-a-uuid'))).toBeNull();
    expect(parseMountPoint(DF)).toBe('/System/Volumes/Data');
    expect(parseMountPoint(DF.replace('/System/Volumes/Data', '/Volumes/My Disk'))).toBe('/Volumes/My Disk');
    expect(parseMountPoint('garbage')).toBeNull();
    expect(parseVolumeUuid(PLIST)).toBe(VOLUME);
    expect(parseVolumeUuid(PLIST + PLIST)).toBeNull();
  });

  it('hashes platform ‖ volume to 16 hex digits and fails closed on any tool failure', async () => {
    expect(machineIdFrom(PLATFORM, VOLUME)).toMatch(/^[0-9a-f]{16}$/);
    const answers: Record<string, string> = { '/usr/sbin/ioreg': IOREG, '/bin/df': DF, '/usr/sbin/diskutil': PLIST };
    const fake = (broken?: string): Runner => async (file) => file === broken ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: answers[file] };
    expect(await computeMachineId(fake(), '/x')).toBe(machineIdFrom(PLATFORM, VOLUME));
    for (const broken of Object.keys(answers)) await expect(computeMachineId(fake(broken), '/x')).rejects.toThrow('E0I_MACHINE_ID');
  });

  it.skipIf(process.platform !== 'darwin')('computes a stable value on this Mac with the real read-only tools', async () => {
    const first = await computeMachineId(systemRunner, process.cwd());
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(await computeMachineId(systemRunner, process.cwd())).toBe(first);
  });
});
