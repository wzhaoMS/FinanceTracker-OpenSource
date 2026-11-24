import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { monotoneBezierSegments, sampleTimeSeries } from './chartSampling.js';

const point = (index: number, value = index) => ({
  t: new Date(Date.UTC(2026, 0, 1) + index * 86400_000).toISOString(),
  value,
  id: `p-${index}`,
});

describe('sampleTimeSeries', () => {
  it('returns a short series unchanged with identity source indices', () => {
    const points = Array.from({ length: 8 }, (_, index) => point(index));
    const result = sampleTimeSeries(points, 20);
    assert.equal(result.points, points);
    assert.deepEqual(result.sourceIndices, [0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('returns only original observations in chronological source order', () => {
    const points = Array.from({ length: 200 }, (_, index) => point(index, Math.sin(index / 8)));
    const result = sampleTimeSeries(points, 40);
    assert.ok(result.points.length <= 40);
    assert.deepEqual(result.points, result.sourceIndices.map((index) => points[index]));
    assert.ok(result.sourceIndices.every((index, position) => (
      position === 0 || index > result.sourceIndices[position - 1]
    )));
  });

  it('supports the compressed observation-index x-axis used by session charts', () => {
    const points = Array.from({ length: 120 }, (_, index) => {
      const item = point(index, Math.sin(index / 6));
      if (index >= 60) item.t = new Date(Date.parse(item.t) + 3 * 86400_000).toISOString();
      return item;
    });
    const result = sampleTimeSeries(points, 30, [], 'index');
    assert.ok(result.sourceIndices.length <= 30);
    assert.equal(result.sourceIndices[0], 0);
    assert.equal(result.sourceIndices.at(-1), points.length - 1);
  });

  it('always preserves endpoints and global extrema', () => {
    const points = Array.from({ length: 200 }, (_, index) => point(index, 100 + Math.sin(index / 5)));
    points[57] = point(57, 20);
    points[143] = point(143, 400);
    const result = sampleTimeSeries(points, 32);
    assert.ok(result.sourceIndices.includes(0));
    assert.ok(result.sourceIndices.includes(points.length - 1));
    assert.ok(result.sourceIndices.includes(57));
    assert.ok(result.sourceIndices.includes(143));
  });

  it('preserves observations nearest unique transaction dates', () => {
    const points = Array.from({ length: 120 }, (_, index) => point(index, Math.cos(index / 4)));
    const anchors = [points[19].t.slice(0, 10), points[74].t.slice(0, 10), points[74].t.slice(0, 10)];
    const result = sampleTimeSeries(points, 24, anchors);
    assert.ok(result.sourceIndices.includes(19));
    assert.ok(result.sourceIndices.includes(74));
  });

  it('preserves both observations around reliability gaps', () => {
    const points = Array.from({ length: 200 }, (_, index) => ({
      ...point(index, Math.sin(index / 8)),
      ...(index === 101 ? { gapBefore: true } : {}),
    }));
    const result = sampleTimeSeries(points, 20);
    assert.ok(result.sourceIndices.includes(100));
    assert.ok(result.sourceIndices.includes(101));
    assert.equal(result.points.find((item) => item.id === 'p-101')?.gapBefore, true);
  });

  it('preserves both observations when captured reliability changes', () => {
    const points = Array.from({ length: 200 }, (_, index) => ({
      ...point(index, Math.sin(index / 8)),
      ...(index >= 75 && index < 150 ? { unreliable: true } : {}),
    }));
    const result = sampleTimeSeries(points, 20);
    for (const boundary of [74, 75, 149, 150]) {
      assert.ok(result.sourceIndices.includes(boundary));
    }
  });

  it('keeps mandatory anchors when they exceed the visual target', () => {
    const points = Array.from({ length: 40 }, (_, index) => point(index, index % 2));
    const anchors = points.slice(1, -1).map((item) => item.t.slice(0, 10));
    const result = sampleTimeSeries(points, 12, anchors);
    assert.equal(result.sourceIndices.length, 40);
  });

  it('rejects invalid values, timestamps, anchors, and targets', () => {
    assert.throws(
      () => sampleTimeSeries([{ t: '2026-01-01', value: Number.NaN }], 10),
      /finite/,
    );
    assert.throws(
      () => sampleTimeSeries([{ t: 'not-a-date', value: 1 }], 10),
      /invalid time-series timestamp/,
    );
    assert.throws(
      () => sampleTimeSeries([point(0), point(1)], 10, ['not-a-date']),
      /invalid time-series timestamp/,
    );
    assert.throws(() => sampleTimeSeries([point(0), point(1)], 2), /at least 3/);
  });

  it('rejects duplicate or decreasing observation timestamps', () => {
    assert.throws(
      () => sampleTimeSeries([point(1), point(0)], 10),
      /strictly increasing/,
    );
    assert.throws(
      () => sampleTimeSeries([point(0), point(0)], 10),
      /strictly increasing/,
    );
  });
});

describe('monotoneBezierSegments', () => {
  it('never overshoots the observed endpoints on monotone segments', () => {
    const xs = [0, 1, 3, 6, 10];
    const ys = [10, 12, 18, 19, 30];
    const segments = monotoneBezierSegments(xs, ys);
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      const low = Math.min(ys[index], ys[index + 1]);
      const high = Math.max(ys[index], ys[index + 1]);
      for (let step = 0; step <= 20; step++) {
        const t = step / 20;
        const y = cubic(
          ys[index],
          segment.control1[1],
          segment.control2[1],
          segment.end[1],
          t,
        );
        assert.ok(y >= low - 1e-9 && y <= high + 1e-9);
      }
    }
  });

  it('preserves a local high and low without creating new extrema', () => {
    const xs = [0, 2, 5, 9, 10];
    const ys = [10, 30, 12, 4, 16];
    const segments = monotoneBezierSegments(xs, ys);
    const sampled = segments.flatMap((segment, index) => (
      Array.from({ length: 21 }, (_, step) => cubic(
        ys[index],
        segment.control1[1],
        segment.control2[1],
        segment.end[1],
        step / 20,
      ))
    ));
    assert.ok(Math.max(...sampled) <= 30 + 1e-9);
    assert.ok(Math.min(...sampled) >= 4 - 1e-9);
  });

  it('rejects duplicate or decreasing x coordinates', () => {
    assert.throws(() => monotoneBezierSegments([0, 1, 1], [1, 2, 3]), /increase/);
    assert.throws(() => monotoneBezierSegments([0, 2, 1], [1, 2, 3]), /increase/);
  });
});

function cubic(start: number, control1: number, control2: number, end: number, t: number): number {
  const inverse = 1 - t;
  return inverse ** 3 * start
    + 3 * inverse ** 2 * t * control1
    + 3 * inverse * t ** 2 * control2
    + t ** 3 * end;
}