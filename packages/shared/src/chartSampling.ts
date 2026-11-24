export interface TimeSeriesPoint {
  t: string;
  value: number;
  /** Preserve both sides of a known missing interval. */
  gapBefore?: boolean;
  /** Captured point whose account ledger was later found incomplete. */
  unreliable?: boolean;
}

export interface SampledTimeSeries<T extends TimeSeriesPoint> {
  points: T[];
  sourceIndices: number[];
}

export type SamplingXAxis = 'time' | 'index';

export interface MonotoneBezierSegment {
  control1: [number, number];
  control2: [number, number];
  end: [number, number];
}

/**
 * Fritsch-Carlson monotone cubic controls for strictly increasing x values.
 * Each curve segment stays within its two observed y endpoints, so smoothing
 * cannot invent a higher peak or lower trough between observations.
 */
export function monotoneBezierSegments(
  xs: number[],
  ys: number[],
): MonotoneBezierSegment[] {
  if (xs.length !== ys.length) throw new Error('monotone curve x/y lengths must match');
  if (xs.length < 2) return [];

  const intervals: number[] = [];
  const slopes: number[] = [];
  for (let index = 0; index < xs.length - 1; index++) {
    const interval = xs[index + 1] - xs[index];
    if (!(interval > 0)) throw new Error('monotone curve x values must increase');
    intervals.push(interval);
    slopes.push((ys[index + 1] - ys[index]) / interval);
  }

  const tangents = new Array<number>(xs.length);
  tangents[0] = slopes[0];
  tangents[tangents.length - 1] = slopes[slopes.length - 1];
  for (let index = 1; index < xs.length - 1; index++) {
    const previous = slopes[index - 1];
    const next = slopes[index];
    if (previous === 0 || next === 0 || Math.sign(previous) !== Math.sign(next)) {
      tangents[index] = 0;
      continue;
    }
    const previousWidth = intervals[index - 1];
    const nextWidth = intervals[index];
    const weight1 = 2 * nextWidth + previousWidth;
    const weight2 = nextWidth + 2 * previousWidth;
    tangents[index] = (weight1 + weight2) / (weight1 / previous + weight2 / next);
  }

  for (let index = 0; index < slopes.length; index++) {
    const slope = slopes[index];
    if (slope === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const alpha = tangents[index] / slope;
    const beta = tangents[index + 1] / slope;
    const magnitude = Math.hypot(alpha, beta);
    if (magnitude > 3) {
      const scale = 3 / magnitude;
      tangents[index] = scale * alpha * slope;
      tangents[index + 1] = scale * beta * slope;
    }
  }

  return slopes.map((_, index) => {
    const third = intervals[index] / 3;
    return {
      control1: [
        xs[index] + third,
        ys[index] + tangents[index] * third,
      ],
      control2: [
        xs[index + 1] - third,
        ys[index + 1] - tangents[index + 1] * third,
      ],
      end: [xs[index + 1], ys[index + 1]],
    };
  });
}

/**
 * Shape-preserving visual sampling for dense time series. Every returned
 * point is an original observation; no values or timestamps are synthesized.
 * Endpoints, global extrema, and observations nearest `anchorDates` are
 * mandatory even when that makes the result slightly denser than requested.
 */
export function sampleTimeSeries<T extends TimeSeriesPoint>(
  points: T[],
  targetCount: number,
  anchorDates: string[] = [],
  xAxis: SamplingXAxis = 'time',
): SampledTimeSeries<T> {
  if (!Number.isFinite(targetCount) || targetCount < 3) {
    throw new Error('time-series sample target must be at least 3');
  }
  const target = Math.max(3, Math.floor(targetCount));
  const times = validateSeries(points);
  const sampleX = xAxis === 'index' ? points.map((_, index) => index) : times;
  const anchorTimes = Array.from(new Set(anchorDates)).map((date) => parseTime(date));
  if (points.length <= target) {
    return {
      points,
      sourceIndices: points.map((_, index) => index),
    };
  }

  const mandatory = mandatoryIndices(points, times, anchorTimes);
  if (mandatory.size >= target) {
    const sourceIndices = Array.from(mandatory).sort((left, right) => left - right);
    return { points: sourceIndices.map((index) => points[index]), sourceIndices };
  }

  const nonEndpointMandatory = Math.max(0, mandatory.size - 2);
  const lttbTarget = Math.max(3, target - nonEndpointMandatory);
  const selected = new Set<number>([
    ...mandatory,
    ...largestTriangleThreeBucketsIndices(points, sampleX, lttbTarget),
  ]);
  const sourceIndices = Array.from(selected).sort((left, right) => left - right);
  return { points: sourceIndices.map((index) => points[index]), sourceIndices };
}

function mandatoryIndices<T extends TimeSeriesPoint>(
  points: T[],
  times: number[],
  anchorTimes: number[],
): Set<number> {
  const indices = new Set<number>([0, points.length - 1]);
  let minIndex = 0;
  let maxIndex = 0;
  for (let index = 1; index < points.length; index++) {
    if (points[index].value < points[minIndex].value) minIndex = index;
    if (points[index].value > points[maxIndex].value) maxIndex = index;
  }
  indices.add(minIndex);
  indices.add(maxIndex);

  for (let index = 1; index < points.length; index++) {
    if (
      !points[index].gapBefore
      && Boolean(points[index].unreliable) === Boolean(points[index - 1].unreliable)
    ) continue;
    indices.add(index - 1);
    indices.add(index);
  }

  for (const target of anchorTimes) {
    indices.add(nearestTimeIndex(times, target));
  }
  return indices;
}

function largestTriangleThreeBucketsIndices<T extends TimeSeriesPoint>(
  points: T[],
  times: number[],
  targetCount: number,
): number[] {
  if (points.length <= targetCount) return points.map((_, index) => index);

  const sampled = [0];
  const bucketSize = (points.length - 2) / (targetCount - 2);
  let anchorIndex = 0;

  for (let bucket = 0; bucket < targetCount - 2; bucket++) {
    const averageStart = Math.floor((bucket + 1) * bucketSize) + 1;
    const averageEnd = Math.min(Math.floor((bucket + 2) * bucketSize) + 1, points.length);
    let averageX = 0;
    let averageY = 0;
    const averageLength = Math.max(1, averageEnd - averageStart);
    for (let index = averageStart; index < averageEnd; index++) {
      averageX += times[index];
      averageY += points[index].value;
    }
    if (averageEnd <= averageStart) {
      averageX = times[times.length - 1];
      averageY = points[points.length - 1].value;
    } else {
      averageX /= averageLength;
      averageY /= averageLength;
    }

    const rangeStart = Math.floor(bucket * bucketSize) + 1;
    const rangeEnd = Math.min(Math.floor((bucket + 1) * bucketSize) + 1, points.length - 1);
    const anchorX = times[anchorIndex];
    const anchorY = points[anchorIndex].value;
    let selectedIndex = rangeStart;
    let maxArea = -1;
    for (let index = rangeStart; index < rangeEnd; index++) {
      const candidateX = times[index];
      const area = Math.abs(
        (anchorX - averageX) * (points[index].value - anchorY)
        - (anchorX - candidateX) * (averageY - anchorY),
      );
      if (area > maxArea) {
        maxArea = area;
        selectedIndex = index;
      }
    }
    sampled.push(selectedIndex);
    anchorIndex = selectedIndex;
  }
  sampled.push(points.length - 1);
  return sampled;
}

function parseTime(value: string): number {
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid time-series timestamp: ${value}`);
  return parsed;
}

function validateSeries<T extends TimeSeriesPoint>(points: T[]): number[] {
  const times: number[] = [];
  for (let index = 0; index < points.length; index++) {
    if (!Number.isFinite(points[index].value)) {
      throw new Error(`time-series value at index ${index} must be finite`);
    }
    const time = parseTime(points[index].t);
    if (index > 0 && time <= times[index - 1]) {
      throw new Error('time-series timestamps must be strictly increasing');
    }
    times.push(time);
  }
  return times;
}

function nearestTimeIndex(times: number[], target: number): number {
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (times[middle] < target) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  const previous = low - 1;
  return Math.abs(times[low] - target) < Math.abs(times[previous] - target)
    ? low
    : previous;
}