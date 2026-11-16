/**
 * Scaling checks for tests that guard complexity (linear vs quadratic or worse).
 *
 * A fixed wall-clock bound such as `expect(elapsed).toBeLessThan(1000)` fails on a slow shared CI runner and
 * passes on a fast laptop even when the code has become quadratic. These helpers time the SAME work at N and at
 * k*N, keep the fastest of several runs of each (noise only ever adds time), and bound the ratio of the two.
 * Linear work gives a ratio near k (8), quadratic work near k*k (64). The ratio bound (24) sits between them with a wide margin,
 * and a generous per-run hang limit still catches work that never finishes.
 *
 * Pick N so that one run at N takes a few milliseconds on a fast machine; the batch calibration below also
 * repeats the work until one sample is long enough to time. Prove each use with a mutant: make the code under test
 * quadratic and the test must fail.
 */
export type ScalingOptions = {
  /** The base size. `make(n)` builds the input for size n OUTSIDE the timed region and returns the work to time. */
  n: number;
  /** Size multiplier. Default 8: linear ~8x, quadratic ~64x. */
  k?: number;
  /** Timed samples kept per size (the fastest wins). Default 5, after one warm-up. */
  runs?: number;
  /** Largest allowed (time at k*N) / (time at N). Default 3*k (24 at k=8): linear ~8 (shared CI runners measured up to ~11.6 at k=4 with a bound of 10), quadratic ~64, so the margin is wide on both sides. */
  maxRatio?: number;
  /** Times below this many ms count as this many ms, so timer noise on a tiny N cannot fail a linear run. Default 2. */
  floorMs?: number;
  /** One sample must be at least this long, so the work is repeated (the same count at N and k*N). Default 8. */
  minSampleMs?: number;
  /** Generous hang limit for ONE timed sample, in ms. Default 30000. */
  hangMs?: number;
  /** Shown in failure messages. */
  label?: string;
};

export type ScalingResult = { ms: number; msK: number; ratio: number; batches: number; n: number; k: number };

function settings(options: ScalingOptions) {
  const k = options.k ?? 8;
  const runs = options.runs ?? 5;
  const maxRatio = options.maxRatio ?? 3 * k;
  const floorMs = options.floorMs ?? 2;
  const minSampleMs = options.minSampleMs ?? 8;
  const hangMs = options.hangMs ?? 30_000;
  const label = options.label ?? "scaling";
  if (!(options.n >= 1) || !(k > 1) || runs < 1 || !(maxRatio > k)) throw new Error(`${label}: bad scaling options`);
  return { n: options.n, k, runs, maxRatio, floorMs, minSampleMs, hangMs, label };
}

function verdict(label: string, s: ReturnType<typeof settings>, ms: number, msK: number, batches: number): ScalingResult {
  const ratio = msK / Math.max(ms, s.floorMs);
  const shown = `${label}: N=${s.n} ${ms.toFixed(2)} ms, ${s.k}N=${s.n * s.k} ${msK.toFixed(2)} ms, ratio ${ratio.toFixed(2)} (limit ${s.maxRatio}), batches ${batches}`;
  if (ratio > s.maxRatio) throw new Error(`Work grew faster than linear. ${shown}`);
  if (ms > s.hangMs || msK > s.hangMs) throw new Error(`Hang limit exceeded. ${shown}`);
  return { ms, msK, ratio, batches, n: s.n, k: s.k };
}

/** Synchronous work. `make(n)` returns the function to time; it is called `batches` times per sample. */
export function expectLinearScaling(make: (n: number) => () => unknown, options: ScalingOptions): ScalingResult {
  const s = settings(options);
  const small = make(s.n);
  const large = make(s.n * s.k);
  const sample = (work: () => unknown, batches: number) => {
    const start = performance.now();
    for (let i = 0; i < batches; i++) work();
    return performance.now() - start;
  };
  let batches = 1;
  while (batches < 4096) {
    const took = sample(small, batches);
    if (took >= s.minSampleMs) break;
    if (took > s.hangMs) break;
    batches *= 2;
  }
  const fastest = (work: () => unknown) => {
    sample(work, batches); // warm-up
    let best = Infinity;
    for (let i = 0; i < s.runs; i++) {
      const took = sample(work, batches);
      if (took > s.hangMs) { best = took; break; }
      best = Math.min(best, took);
    }
    return best;
  };
  const ms = fastest(small);
  if (ms > s.hangMs) return verdict(s.label, s, ms, ms, batches);
  const msK = fastest(large);
  return verdict(s.label, s, ms, msK, batches);
}

/** Async work, same contract. The timed function may return a promise. */
export async function expectLinearScalingAsync(make: (n: number) => () => unknown, options: ScalingOptions): Promise<ScalingResult> {
  const s = settings(options);
  const small = make(s.n);
  const large = make(s.n * s.k);
  const sample = async (work: () => unknown, batches: number) => {
    const start = performance.now();
    for (let i = 0; i < batches; i++) await work();
    return performance.now() - start;
  };
  let batches = 1;
  while (batches < 4096) {
    const took = await sample(small, batches);
    if (took >= s.minSampleMs) break;
    if (took > s.hangMs) break;
    batches *= 2;
  }
  const fastest = async (work: () => unknown) => {
    await sample(work, batches); // warm-up
    let best = Infinity;
    for (let i = 0; i < s.runs; i++) {
      const took = await sample(work, batches);
      if (took > s.hangMs) { best = took; break; }
      best = Math.min(best, took);
    }
    return best;
  };
  const ms = await fastest(small);
  if (ms > s.hangMs) return verdict(s.label, s, ms, ms, batches);
  const msK = await fastest(large);
  return verdict(s.label, s, ms, msK, batches);
}
