import fs from 'node:fs';
import path from 'node:path';

// Wall-clock benchmarks share the disk with whatever wrote to it just before them. A file just written (another test's
// database, a benchmark's own copy of its ledger) is written back by the operating system over the following seconds,
// and a flush to the same disk in the meantime (a SQLite commit's checkpoint) waits behind that writeback: a call that
// usually takes 150 ms then takes seconds. These helpers keep that writeback out of a measured window: `flushFile`
// writes a fixture's buffered data out before the clock starts, and `waitForQuietDisk` waits until a small durable write
// is quick again. Neither changes what is measured or how it is judged.

/** Writes a file's buffered data to disk (fsync) and returns how long that took, in ms. */
export function flushFile(file: string): number {
  const started = performance.now();
  const fd = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return performance.now() - started;
}

/** What `waitForQuietDisk` saw. Times in ms. */
export interface QuietDisk {
  /** `consecutive` probes in a row took at most `quietMs` each before `maxWaitMs` ran out. */
  quiet: boolean;
  waitedMs: number;
  probes: number;
  slowestMs: number;
  lastMs: number;
}

export interface QuietDiskOptions {
  quietMs?: number;
  consecutive?: number;
  pauseMs?: number;
  maxWaitMs?: number;
}

const sleep = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Waits until the disk under `dir` is quiet: a 4 KiB write and fsync of a probe file in `dir` takes at most `quietMs`,
 * `consecutive` times in a row, `pauseMs` apart. It gives up after `maxWaitMs` and says so in its result; it never throws
 * for a busy disk. Synchronous, for synchronous benchmark code.
 */
export function waitForQuietDisk(dir: string, options: QuietDiskOptions = {}): QuietDisk {
  const { quietMs = 50, consecutive = 5, pauseMs = 100, maxWaitMs = 60_000 } = options;
  const file = path.join(dir, `quiet-disk-probe-${process.pid}.bin`);
  const block = Buffer.alloc(4096, 0x5a);
  const started = performance.now();
  let probes = 0;
  let streak = 0;
  let slowestMs = 0;
  let lastMs = 0;
  const fd = fs.openSync(file, 'w');
  try {
    for (;;) {
      const t = performance.now();
      fs.writeSync(fd, block, 0, block.length, 0);
      fs.fsyncSync(fd);
      lastMs = performance.now() - t;
      probes += 1;
      slowestMs = Math.max(slowestMs, lastMs);
      streak = lastMs <= quietMs ? streak + 1 : 0;
      const waitedMs = performance.now() - started;
      if (streak >= consecutive || waitedMs >= maxWaitMs) {
        return { quiet: streak >= consecutive, waitedMs, probes, slowestMs, lastMs };
      }
      sleep(pauseMs);
    }
  } finally {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
  }
}
