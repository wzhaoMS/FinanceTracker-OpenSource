/**
 * Robust statistics and explainable monthly forecasts for spending series, on numbers only (cardSpendingForecast.ts
 * reads card rows into monthly series): the median and the MAD, ranges from empirical quantiles of backtest errors,
 * four forecasting methods (median run-rate, seasonal naive, damped-trend ETS and damped Holt-Winters), rolling-origin
 * backtests with MAE, MASE, MAPE and range coverage, and the choice of method by the history there is. Pure and
 * deterministic; every threshold is a named constant here.
 *
 * A monthly series is an array of months, oldest first. `null` marks a month that is not known (its card coverage is
 * partial): it is never fitted, never an actual and never part of a benchmark, and the methods carry their state
 * across it.
 *
 * Methods after Hyndman & Athanasopoulos, Forecasting: Principles and Practice (3rd ed., otexts.com/fpp3): the
 * seasonal naive (5.2), ETS with an additive damped trend and additive seasonality (8.1 to 8.3), evaluation on a
 * rolling forecasting origin (5.10) and MASE (5.8).
 *
 * A backtest forecasts each month of the series from every origin the method can forecast from, at the offsets the
 * real forecast uses. Accuracy (MAE, MASE, MAPE) is reported on the last fifth of the known months, and methods are
 * compared there. A range is the point plus empirical quantiles of all the backtest's errors, taken at the ranks
 * split-conformal prediction uses: of n sorted errors, the floor((n+1)(1-p)/2)-th and the ceil((n+1)(1+p)/2)-th
 * smallest for a level p. A month's errors at several offsets move together, so a range also needs errors from
 * {@link CARD_SPENDING_STATS}.rangeMinTargets different months: on simulated series, ranges calibrated on the last
 * fifth alone held the outcome barely more than half the time an 80% range should, and these hold it within a few
 * points of their level (cardSpendingStats.test.ts). A range is given only with its own coverage tested: each month's
 * past forecasts against the range the other months' errors give, by that same rule, so it needs errors from
 * {@link CARD_SPENDING_STATS}.rangeMinMonths months; every range given carries that coverage. Otherwise there is no
 * range.
 */

/** Months oldest first; null where the month is not known. */
export type SpendingSeries = ReadonlyArray<number | null>;

/**
 * How a series is forecast: the median of recent months, the same month a year before, an exponentially smoothed
 * level with a damped trend (ETS(A,Ad,N)), or that with additive seasonality (ETS(A,Ad,A), damped Holt-Winters).
 */
export type CardForecastMethod = 'median-run-rate' | 'seasonal-naive' | 'ets-damped' | 'holt-winters-damped';

/** The ranges given: 80% and 95%. */
export type CardRangeLevel = 80 | 95;

export const CARD_RANGE_LEVELS: readonly CardRangeLevel[] = [80, 95];

export const CARD_SPENDING_STATS = {
  /** 1.4826 x MAD estimates the standard deviation of normal data. */
  madToSigma: 1.4826,
  /** When the MAD is 0 (more than half the values equal): 1.2533 x the mean absolute deviation from the median. */
  meanAbsoluteDeviationToSigma: 1.2533,
  /** Months in a year: the seasonal period. */
  seasonLength: 12,
  /** Median run-rate: the median of the last this many known months, needing at least `runRateMinMonths`. */
  runRateMonths: 6,
  runRateMinMonths: 3,
  /** Seasonal naive: at least a year of known months. */
  seasonalMinMonths: 12,
  /** Damped ETS: at least a year of known months; its start is a line through the first `etsStartMonths`. */
  etsMinMonths: 12,
  etsStartMonths: 12,
  /** Damped Holt-Winters: two full years, every month known in the first two (they set its start). */
  holtWintersMinMonths: 24,
  /** Backtests evaluate the last fifth of the known months, at least three of them. */
  backtestShare: 0.2,
  backtestMinTargets: 3,
  /** MASE scales by the seasonal naive's in-sample error once this many same-month pairs are known, else the naive's. */
  maseSeasonalMinPairs: 3,
  /**
   * A range needs backtest errors from at least this many different months: a month's errors at several offsets move
   * together, and with fewer months the 80% ranges held the outcome barely 70% of the time in simulation.
   */
  rangeMinTargets: 9,
  /**
   * A range is given only when its coverage is tested on every month it comes from: each month's errors against the
   * range the other months give (made from at least `rangeMinTargets` of them). So a range needs errors from this many
   * months, and never goes out with nothing tested.
   */
  rangeMinMonths: 10,
  /**
   * A 95% range needs 39 errors for its own ranks. With fewer, it is the 80% range widened around the errors' median by
   * z(0.975) / z(0.90), the ratio of normal quantiles (labelled `extended`).
   */
  rangeExtension: 1.959964 / 1.281552,
} as const;

/**
 * Methods by the known months a series has, as Spending's design sets them: 24 or more, damped ETS (or damped
 * Holt-Winters, with two full years at every backtest origin) or seasonal naive, whichever backtests better; 12 to
 * 23, seasonal naive; 3 to 11, the median run-rate. A band whose methods cannot be backtested gives way to the next.
 * Within a band, ties go to the simpler method (listed first).
 */
export const CARD_FORECAST_LADDER: ReadonlyArray<{ minMonths: number; methods: readonly CardForecastMethod[] }> = [
  { minMonths: 24, methods: ['seasonal-naive', 'ets-damped', 'holt-winters-damped'] },
  { minMonths: 12, methods: ['seasonal-naive'] },
  { minMonths: 3, methods: ['median-run-rate'] },
];

/** The damped methods' smoothing parameters, searched on a fixed grid (first best wins): deterministic and cheap. */
const ETS_ALPHAS = [0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9] as const;
/** The trend's smoothing, as a share of alpha (beta = share x alpha, so 0 < beta < alpha). */
const ETS_BETA_SHARES = [0.01, 0.1, 0.3] as const;
/** Damping, within the 0.8 to 0.98 that fpp3 recommends. */
const ETS_PHIS = [0.8, 0.9, 0.98] as const;
/** Seasonal smoothing, kept at or below 1 - alpha. */
const HW_GAMMAS = [0.01, 0.1, 0.2, 0.3] as const;

// ---------------------------------------------------------------------------
// Robust statistics
// ---------------------------------------------------------------------------

/** The known values of a series, in order. */
export function knownValues(series: SpendingSeries): number[] {
  return series.filter((value): value is number => value !== null);
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** The median (the mean of the two middle values for an even count); NaN for none. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The median absolute deviation from `center` (by default the median). */
export function medianAbsoluteDeviation(values: readonly number[], center = median(values)): number {
  return median(values.map((value) => Math.abs(value - center)));
}

/** A robust centre and spread: the median, and a standard deviation estimated without letting outliers in. */
export interface RobustSpread {
  median: number;
  sigma: number;
  /** `mad`: 1.4826 x MAD; `mean-absolute-deviation`: 1.2533 x the mean absolute deviation (the MAD was 0); `none`: all equal. */
  basis: 'mad' | 'mean-absolute-deviation' | 'none';
}

/** The median and robust sigma of some values (at least one). */
export function robustSpread(values: readonly number[]): RobustSpread {
  if (values.length === 0) throw new RangeError('robustSpread needs at least one value');
  const center = median(values);
  const mad = medianAbsoluteDeviation(values, center);
  if (mad > 0) return { median: center, sigma: CARD_SPENDING_STATS.madToSigma * mad, basis: 'mad' };
  const meanDeviation = mean(values.map((value) => Math.abs(value - center)));
  if (meanDeviation > 0) {
    return { median: center, sigma: CARD_SPENDING_STATS.meanAbsoluteDeviationToSigma * meanDeviation, basis: 'mean-absolute-deviation' };
  }
  return { median: center, sigma: 0, basis: 'none' };
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/** A range of errors, or of outcomes: `extended` when a 95% range came from the 80% one's widths. */
export interface SpendingRange {
  lower: number;
  upper: number;
  basis: 'empirical' | 'extended';
}

/** How a range held when tested: past outcomes inside the ranges they were tested against, of how many tested. */
export interface RangeCoverage {
  inside: number;
  tested: number;
}

/** A range given with a forecast, and its tested coverage (never untested). */
export interface TestedRange extends SpendingRange {
  coverage: RangeCoverage;
}

/**
 * The ranks of a `level` range among n sorted values (1-based): floor((n+1)(100-level)/200) and
 * ceil((n+1)(100+level)/200), in whole-number arithmetic. Null when either falls outside 1..n (too few values).
 */
export function rangeRanks(count: number, level: CardRangeLevel): { lower: number; upper: number } | null {
  const lower = Math.floor(((count + 1) * (100 - level)) / 200);
  const upper = Math.ceil(((count + 1) * (100 + level)) / 200);
  return lower >= 1 && upper <= count ? { lower, upper } : null;
}

/** The fewest values a `level` range needs from its own ranks: 9 for 80%, 39 for 95%. */
export function rangeMinValues(level: CardRangeLevel): number {
  let count = 1;
  while (!rangeRanks(count, level)) count += 1;
  return count;
}

/**
 * The range a new value falls in at `level`, from values like it (backtest errors, or earlier months): the values
 * at the level's ranks. A 95% range with too few values for its ranks is the 80% range widened around the values'
 * median by {@link CARD_SPENDING_STATS}.rangeExtension (`extended`). Null with too few values for an 80% range.
 */
export function empiricalRange(values: readonly number[], level: CardRangeLevel): SpendingRange | null {
  const sorted = [...values].sort((a, b) => a - b);
  const ranks = rangeRanks(sorted.length, level);
  if (ranks) return { lower: sorted[ranks.lower - 1], upper: sorted[ranks.upper - 1], basis: 'empirical' };
  if (level !== 95) return null;
  const inner = empiricalRange(sorted, 80);
  if (!inner) return null;
  const center = median(sorted);
  const ratio = CARD_SPENDING_STATS.rangeExtension;
  return { lower: center - (center - inner.lower) * ratio, upper: center + (inner.upper - center) * ratio, basis: 'extended' };
}

/**
 * Leave-one-out coverage of the `level` ranges: each value against the range the others give. `tested` counts the
 * values with such a range. With exchangeable errors this estimates how often a range holds a new outcome, without
 * scoring a range on the errors it was made from.
 */
export function leaveOneOutCoverage(values: readonly number[], level: CardRangeLevel): RangeCoverage {
  let inside = 0;
  let tested = 0;
  values.forEach((value, index) => {
    const range = empiricalRange(values.filter((_, other) => other !== index), level);
    if (!range) return;
    tested += 1;
    if (value >= range.lower && value <= range.upper) inside += 1;
  });
  return { inside, tested };
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

interface Smoothing {
  alpha: number;
  beta: number;
  phi: number;
  gamma: number;
}

/** phi + phi^2 + ... + phi^steps: how much of the trend reaches `steps` months ahead. */
function dampedSteps(phi: number, steps: number): number {
  let total = 0;
  let power = 1;
  for (let step = 1; step <= steps; step += 1) {
    power *= phi;
    total += power;
  }
  return total;
}

/** Level and trend before the first month: a least-squares line through the first `points` known months. */
function lineStart(train: SpendingSeries, points: number): { level: number; trend: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let index = 0; index < train.length && xs.length < points; index += 1) {
    const value = train[index];
    if (value === null) continue;
    xs.push(index);
    ys.push(value);
  }
  if (xs.length < 2) return null;
  const meanX = mean(xs);
  const meanY = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let index = 0; index < xs.length; index += 1) {
    sxy += (xs[index] - meanX) * (ys[index] - meanY);
    sxx += (xs[index] - meanX) ** 2;
  }
  const trend = sxx > 0 ? sxy / sxx : 0;
  return { level: meanY - trend * (meanX + 1), trend };
}

/** ETS(A,Ad,N) through the series: one-step squared errors, and the level and trend after its last month. */
function runDamped(train: SpendingSeries, start: { level: number; trend: number }, p: Smoothing) {
  let { level, trend } = start;
  let sse = 0;
  for (const value of train) {
    const forecast = level + p.phi * trend;
    if (value === null) {
      level = forecast;
      trend *= p.phi;
      continue;
    }
    const error = value - forecast;
    sse += error * error;
    level = forecast + p.alpha * error;
    trend = p.phi * trend + p.beta * error;
  }
  return { sse, level, trend };
}

/** Classical start for Holt-Winters: two full years, each month detrended against its year's mean. */
function seasonalStart(train: SpendingSeries): { level: number; trend: number; season: number[] } | null {
  const m = CARD_SPENDING_STATS.seasonLength;
  if (train.length < 2 * m) return null;
  const first = train.slice(0, m);
  const second = train.slice(m, 2 * m);
  if (first.some((value) => value === null) || second.some((value) => value === null)) return null;
  const firstMean = mean(first as number[]);
  const secondMean = mean(second as number[]);
  const trend = (secondMean - firstMean) / m;
  const center = (m - 1) / 2;
  const raw = Array.from({ length: m }, (_, slot) =>
    ((first[slot] as number) - (firstMean + trend * (slot - center)) + (second[slot] as number) - (secondMean + trend * (slot - center))) / 2);
  const shift = mean(raw);
  return { level: firstMean - trend * (center + 1), trend, season: raw.map((value) => value - shift) };
}

/** ETS(A,Ad,A) through the series: one-step squared errors, and the states after its last month. */
function runSeasonal(train: SpendingSeries, start: { level: number; trend: number; season: readonly number[] }, p: Smoothing) {
  const m = CARD_SPENDING_STATS.seasonLength;
  let { level, trend } = start;
  const season = [...start.season];
  let sse = 0;
  train.forEach((value, index) => {
    const slot = index % m;
    const base = level + p.phi * trend;
    if (value === null) {
      level = base;
      trend *= p.phi;
      return;
    }
    const error = value - (base + season[slot]);
    sse += error * error;
    level = base + p.alpha * error;
    trend = p.phi * trend + p.beta * error;
    season[slot] += p.gamma * error;
  });
  return { sse, level, trend, season };
}

/** Every grid point, in a fixed order: the first with the smallest error wins. */
function grid(seasonal: boolean): Smoothing[] {
  const points: Smoothing[] = [];
  for (const alpha of ETS_ALPHAS) {
    for (const share of ETS_BETA_SHARES) {
      for (const phi of ETS_PHIS) {
        for (const gamma of seasonal ? HW_GAMMAS : [0]) {
          if (seasonal && gamma > 1 - alpha) continue;
          points.push({ alpha, beta: share * alpha, phi, gamma });
        }
      }
    }
  }
  return points;
}
const DAMPED_GRID = grid(false);
const SEASONAL_GRID = grid(true);

function etsDamped(train: SpendingSeries, offsets: readonly number[]): number[] | null {
  if (knownValues(train).length < CARD_SPENDING_STATS.etsMinMonths) return null;
  const start = lineStart(train, CARD_SPENDING_STATS.etsStartMonths);
  if (!start) return null;
  let best: { sse: number; level: number; trend: number; phi: number } | null = null;
  for (const point of DAMPED_GRID) {
    const fit = runDamped(train, start, point);
    if (best === null || fit.sse < best.sse) best = { ...fit, phi: point.phi };
  }
  const fit = best!;
  return offsets.map((offset) => fit.level + dampedSteps(fit.phi, offset) * fit.trend);
}

function holtWintersDamped(train: SpendingSeries, offsets: readonly number[]): number[] | null {
  if (knownValues(train).length < CARD_SPENDING_STATS.holtWintersMinMonths) return null;
  const start = seasonalStart(train);
  if (!start) return null;
  let best: { sse: number; level: number; trend: number; season: number[]; phi: number } | null = null;
  for (const point of SEASONAL_GRID) {
    const fit = runSeasonal(train, start, point);
    if (best === null || fit.sse < best.sse) best = { ...fit, phi: point.phi };
  }
  const fit = best!;
  const m = CARD_SPENDING_STATS.seasonLength;
  return offsets.map((offset) => fit.level + dampedSteps(fit.phi, offset) * fit.trend + fit.season[(train.length - 1 + offset) % m]);
}

function medianRunRate(train: SpendingSeries, offsets: readonly number[]): number[] | null {
  const recent = knownValues(train).slice(-CARD_SPENDING_STATS.runRateMonths);
  if (recent.length < CARD_SPENDING_STATS.runRateMinMonths) return null;
  const value = median(recent);
  return offsets.map(() => value);
}

function seasonalNaive(train: SpendingSeries, offsets: readonly number[]): number[] | null {
  if (knownValues(train).length < CARD_SPENDING_STATS.seasonalMinMonths) return null;
  const m = CARD_SPENDING_STATS.seasonLength;
  const last = train.length - 1;
  const points: number[] = [];
  for (const offset of offsets) {
    // The same month in the latest year known before the forecast's origin.
    let index = last + offset - m;
    while (index > last) index -= m;
    while (index >= 0 && train[index] === null) index -= m;
    if (index < 0) return null;
    points.push(train[index] as number);
  }
  return points;
}

/**
 * Point forecasts `offsets` months after the training series' last month (1 is the month right after it); null
 * when the method cannot forecast from that history.
 */
export function forecastSeries(method: CardForecastMethod, train: SpendingSeries, offsets: readonly number[]): number[] | null {
  if (offsets.some((offset) => !Number.isInteger(offset) || offset < 1)) throw new RangeError('offsets are whole months after the series');
  switch (method) {
    case 'median-run-rate': return medianRunRate(train, offsets);
    case 'seasonal-naive': return seasonalNaive(train, offsets);
    case 'ets-damped': return etsDamped(train, offsets);
    case 'holt-winters-damped': return holtWintersDamped(train, offsets);
    default: throw new RangeError('unknown forecasting method');
  }
}

// ---------------------------------------------------------------------------
// Backtests
// ---------------------------------------------------------------------------

/** One backtest forecast: the target month (series index), how many months ahead it was made, and its error. */
export interface BacktestError {
  target: number;
  offset: number;
  actual: number;
  forecast: number;
  /** actual - forecast. */
  error: number;
}

export interface SeriesBacktest {
  method: CardForecastMethod;
  /** The months accuracy is reported on: the last fifth of the known months (series indexes), oldest first. */
  targets: number[];
  /** The last month of each training window behind `errors` (series indexes), oldest first. */
  origins: number[];
  /** The forecasts of `targets`, per target, then per offset. */
  errors: BacktestError[];
  /** Every forecast the method could make inside the series, by target then offset: what ranges are calibrated on. */
  calibration: BacktestError[];
}

/**
 * Evaluation on a rolling origin. Every month of the series is forecast from each offset the real forecast uses, by
 * the method fitted only on the months up to that origin, wherever the method can forecast from them (`calibration`).
 * Accuracy is reported on the last fifth of the known months (at least {@link CARD_SPENDING_STATS}.backtestMinTargets):
 * null when the method cannot forecast every one of those from every offset (not enough history before them).
 */
export function backtestSeries(series: SpendingSeries, method: CardForecastMethod, offsets: readonly number[]): SeriesBacktest | null {
  const known = series.flatMap((value, index) => (value === null ? [] : [index]));
  const count = Math.max(CARD_SPENDING_STATS.backtestMinTargets, Math.round(known.length * CARD_SPENDING_STATS.backtestShare));
  if (offsets.length === 0 || count >= known.length) return null;
  const calibration: BacktestError[] = [];
  for (let origin = 0; origin < series.length - 1; origin += 1) {
    const wanted = offsets.filter((offset) => origin + offset < series.length && series[origin + offset] !== null);
    if (wanted.length === 0) continue;
    const points = forecastSeries(method, series.slice(0, origin + 1), wanted);
    if (!points) continue;
    wanted.forEach((offset, index) => {
      const target = origin + offset;
      const actual = series[target] as number;
      calibration.push({ target, offset, actual, forecast: points[index], error: actual - points[index] });
    });
  }
  calibration.sort((a, b) => a.target - b.target || a.offset - b.offset);
  const byKey = new Map(calibration.map((item) => [`${item.target}:${item.offset}`, item]));
  const targets = known.slice(-count);
  const errors: BacktestError[] = [];
  for (const target of targets) {
    for (const offset of offsets) {
      const item = byKey.get(`${target}:${offset}`);
      if (!item) return null;
      errors.push(item);
    }
  }
  const origins = [...new Set(errors.map((item) => item.target - item.offset))].sort((a, b) => a - b);
  return { method, targets, origins, errors, calibration };
}

/** The `level` range of a backtest's errors, from all its forecasts; null with errors from too few months, or too few errors. */
export function calibratedRange(calibration: readonly BacktestError[], level: CardRangeLevel): SpendingRange | null {
  if (new Set(calibration.map((item) => item.target)).size < CARD_SPENDING_STATS.rangeMinTargets) return null;
  return empiricalRange(calibration.map((item) => item.error), level);
}

/**
 * Leave-one-month-out coverage of a backtest's `level` ranges: each month's errors against the range the other months'
 * errors give, by the rule every range is made by ({@link calibratedRange}: so only with `rangeMinTargets` months
 * besides it). `tested` counts the errors so checked: all of them once there are `rangeMinMonths` months, none before.
 */
export function calibratedCoverage(calibration: readonly BacktestError[], level: CardRangeLevel): RangeCoverage {
  let inside = 0;
  let tested = 0;
  for (const target of new Set(calibration.map((item) => item.target))) {
    const range = calibratedRange(calibration.filter((item) => item.target !== target), level);
    if (!range) continue;
    for (const item of calibration) {
      if (item.target !== target) continue;
      tested += 1;
      if (item.error >= range.lower && item.error <= range.upper) inside += 1;
    }
  }
  return { inside, tested };
}

/** What a naive forecast's in-sample errors are: MASE's scale. */
export interface MaseScale {
  scale: number;
  /** The seasonal naive's (same month a year before) once enough pairs are known, else the naive's (month before). */
  benchmark: 'seasonal-naive' | 'naive';
}

/** The in-sample mean absolute error of the seasonal naive (or, with too few same-month pairs, the naive) over a series. */
export function maseScale(series: SpendingSeries): MaseScale | null {
  const differences = (lag: number) => {
    const list: number[] = [];
    for (let index = lag; index < series.length; index += 1) {
      const now = series[index];
      const before = series[index - lag];
      if (now !== null && before !== null) list.push(Math.abs(now - before));
    }
    return list;
  };
  const seasonal = differences(CARD_SPENDING_STATS.seasonLength);
  if (seasonal.length >= CARD_SPENDING_STATS.maseSeasonalMinPairs) return { scale: mean(seasonal), benchmark: 'seasonal-naive' };
  const naive = differences(1);
  return naive.length > 0 ? { scale: mean(naive), benchmark: 'naive' } : null;
}

export interface BacktestMetrics {
  /** Months accuracy is reported on (the last fifth), the origins and forecasts behind it. */
  targets: number;
  origins: number;
  errors: number;
  /** Mean absolute error. */
  mae: number;
  /** Mean error: above 0 when actuals ran above the forecasts. */
  bias: number;
  /** MAE over {@link maseScale}: below 1 beats the benchmark's in-sample one-month-ahead error. Null without a scale (or a zero one). */
  mase: number | null;
  maseBenchmark: MaseScale['benchmark'] | null;
  /** Mean absolute percentage error over actuals at least `nearZero` in size, in percent; null when none is. */
  mape: number | null;
  mapeErrors: number;
  /** Months and forecasts the ranges are calibrated on. */
  calibrationMonths: number;
  calibrationErrors: number;
  /** Leave-one-month-out coverage of the ranges over the calibration (see {@link calibratedCoverage}). */
  coverage80: RangeCoverage;
  coverage95: RangeCoverage;
}

/** A backtest's accuracy over its series. `nearZero`: actuals smaller than this are left out of MAPE. */
export function backtestMetrics(series: SpendingSeries, backtest: SeriesBacktest, options: { nearZero: number }): BacktestMetrics {
  const errors = backtest.errors.map((item) => item.error);
  const mae = mean(errors.map(Math.abs));
  const scale = maseScale(series);
  const forMape = backtest.errors.filter((item) => Math.abs(item.actual) >= options.nearZero && item.actual !== 0);
  return {
    targets: backtest.targets.length,
    origins: backtest.origins.length,
    errors: errors.length,
    mae,
    bias: mean(errors),
    mase: scale && scale.scale > 0 ? mae / scale.scale : null,
    maseBenchmark: scale && scale.scale > 0 ? scale.benchmark : null,
    mape: forMape.length === 0 ? null : (100 * mean(forMape.map((item) => Math.abs(item.error) / Math.abs(item.actual)))),
    mapeErrors: forMape.length,
    calibrationMonths: new Set(backtest.calibration.map((item) => item.target)).size,
    calibrationErrors: backtest.calibration.length,
    coverage80: calibratedCoverage(backtest.calibration, 80),
    coverage95: calibratedCoverage(backtest.calibration, 95),
  };
}

// ---------------------------------------------------------------------------
// The forecast of one series
// ---------------------------------------------------------------------------

export interface SeriesForecastPoint {
  offset: number;
  point: number;
  /** Null unless the backtest tested its coverage (errors from `rangeMinMonths` months); it carries that coverage. */
  range80: TestedRange | null;
  range95: TestedRange | null;
}

export interface SeriesForecast {
  /** Known months in the series. */
  history: number;
  /** Null: fewer than {@link CARD_SPENDING_STATS}.runRateMinMonths known months, so no forecast. */
  method: CardForecastMethod | null;
  /**
   * Backtested; its ranges come from its errors when they come from enough months to test the ranges' coverage. An
   * untested forecast has no range.
   */
  tested: boolean;
  forecasts: SeriesForecastPoint[];
  backtest: (BacktestMetrics & { targetIndexes: number[] }) | null;
  /** Every method tried, in order, with its backtest MAE (null: it could not be backtested). */
  candidates: Array<{ method: CardForecastMethod; mae: number | null }>;
}

/** How much smaller an MAE must be to count as better: float noise is a tie, and ties go to the simpler method. */
const MAE_TOLERANCE = 1e-9;

/**
 * The series' forecast `offsets` months after its last month: the ladder's method for its known months (the best
 * backtest within a band; a band none of whose methods can be backtested gives way to the next), its points, and
 * ranges from its backtest errors, never below min(0, the series' lowest known month). A range is given only with its
 * coverage tested (errors from {@link CARD_SPENDING_STATS}.rangeMinMonths months) and carries it. With only enough
 * months for a median run-rate that cannot be backtested, the point alone (`tested` false); with fewer, no forecast.
 */
export function forecastSpendingSeries(
  series: SpendingSeries,
  offsets: readonly number[],
  options: { nearZero: number },
): SeriesForecast {
  const known = knownValues(series);
  const history = known.length;
  const floor = Math.min(0, ...known);
  const candidates: SeriesForecast['candidates'] = [];
  const clamp = (value: number) => Math.max(floor, value);
  const ranged = (point: number, range: SpendingRange | null, coverage: RangeCoverage): TestedRange | null =>
    (range ? { lower: clamp(point + range.lower), upper: clamp(point + range.upper), basis: range.basis, coverage } : null);
  for (const band of CARD_FORECAST_LADDER) {
    if (history < band.minMonths) continue;
    let best: { backtest: SeriesBacktest; mae: number } | null = null;
    for (const method of band.methods) {
      const backtest = backtestSeries(series, method, offsets);
      const mae = backtest ? mean(backtest.errors.map((item) => Math.abs(item.error))) : null;
      candidates.push({ method, mae });
      if (backtest && mae !== null && (best === null || mae < best.mae - MAE_TOLERANCE * Math.max(1, best.mae))) best = { backtest, mae };
    }
    if (!best) continue;
    const { method, calibration } = best.backtest;
    const points = forecastSeries(method, series, offsets);
    if (!points) continue;
    const metrics = backtestMetrics(series, best.backtest, options);
    // No range goes out untested: only once every month's errors are tested against the range the others give.
    const testable = metrics.calibrationMonths >= CARD_SPENDING_STATS.rangeMinMonths;
    const range80 = testable && metrics.coverage80.tested > 0 ? calibratedRange(calibration, 80) : null;
    const range95 = testable && metrics.coverage95.tested > 0 ? calibratedRange(calibration, 95) : null;
    return {
      history,
      method,
      tested: true,
      forecasts: offsets.map((offset, index) => ({
        offset,
        point: points[index],
        range80: ranged(points[index], range80, metrics.coverage80),
        range95: ranged(points[index], range95, metrics.coverage95),
      })),
      backtest: { ...metrics, targetIndexes: best.backtest.targets },
      candidates,
    };
  }
  const points = history >= CARD_SPENDING_STATS.runRateMinMonths ? forecastSeries('median-run-rate', series, offsets) : null;
  return {
    history,
    method: points ? 'median-run-rate' : null,
    tested: false,
    forecasts: points ? offsets.map((offset, index) => ({ offset, point: points[index], range80: null, range95: null })) : [],
    backtest: null,
    candidates,
  };
}
