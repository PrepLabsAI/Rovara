/**
 * Scaling checks for tests that guard complexity (linear vs quadratic or worse).
 *
 * A fixed wall-clock bound such as `expect(elapsed).toBeLessThan(1000)` fails on a slow shared CI runner and
 * passes on a fast laptop even when the code has become quadratic. These helpers time the SAME work at N and at
 * k*N, keep the fastest of several runs of each (noise only ever adds time), and bound the ratio of the two.
 * Linear work gives a ratio near k (8), quadratic work near k*k (64). The ratio bound (24) sits between them with a wide margin,
 * and a generous per-run hang limit still catches work that never finishes.
 *
 * The work is repeated inside one timed sample until the fastest N sample takes at least `minSampleMs` (20 ms), so a
 * single timer tick, GC pause or scheduler hiccup cannot dominate the N time. The repeat count is calibrated on N
 * from warm, fastest-of-several samples (a single cold sample under-counts the real cost) and then reused for k*N.
 * Keep the k*N input small. Once the input outgrows the CPU cache (a few MB at k*N) every run is slower per byte than the small one, and shared CI runners then show a steady
 * ratio of about 25 for LINEAR code (limit 24, quadratic ~64). The repeat count above keeps a small N stable, so shrink N instead: the helper refuses a k*N input over
 * `maxInputBytes` (256 KiB). State how many bytes one unit of n costs in `unitBytes` (default 1: n is a size in bytes or characters); work that builds no input that grows with n
 * (a loop of n calls on a fixed input) sets `unitBytes: 0`.
 * Prove each use with a mutant: make the code under test
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
  /** The N sample (fastest of the timed runs) must be at least this long, so the work is repeated inside one sample (the same count at N and k*N). Default 20. */
  minSampleMs?: number;
  /** Approximate bytes one unit of n adds to the input. Default 1. Use 0 when the work builds no input that grows with n. */
  unitBytes?: number;
  /** Bytes the work holds in memory whatever n is (registered values, a fixed table): they are in the cache's working set too, so they count toward `maxInputBytes` together with the k*N input. Default 0. */
  fixedBytes?: number;
  /** The largest allowed k*N input in bytes, default 262144 (256 KiB): larger inputs leave the CPU cache and read a steady ~25 on CI for linear code. Shrink N rather than raise this. */
  maxInputBytes?: number;
  /** Generous hang limit for ONE timed sample, in ms. Default 30000. */
  hangMs?: number;
  /** Shown in failure messages. */
  label?: string;
};

const MAX_BATCHES = 1 << 16;

/** The next repeat count: enough that a sample of `tookMs` at `batches` reaches 1.5x the target, at least doubled. */
function grow(batches: number, tookMs: number, minSampleMs: number) {
  const wanted = Math.ceil((batches * minSampleMs * 1.5) / Math.max(tookMs, 0.01));
  return Math.min(MAX_BATCHES, Math.max(batches * 2, wanted));
}

export type ScalingResult = { ms: number; msK: number; ratio: number; batches: number; n: number; k: number };

function settings(options: ScalingOptions) {
  const k = options.k ?? 8;
  const runs = options.runs ?? 5;
  const maxRatio = options.maxRatio ?? 3 * k;
  const floorMs = options.floorMs ?? 2;
  const minSampleMs = options.minSampleMs ?? 20;
  const hangMs = options.hangMs ?? 30_000;
  const label = options.label ?? "scaling";
  const unitBytes = options.unitBytes ?? 1;
  const maxInputBytes = options.maxInputBytes ?? 262_144;
  const fixedBytes = options.fixedBytes ?? 0;
  if (!(options.n >= 1) || !(k > 1) || runs < 1 || !(maxRatio > k) || !(unitBytes >= 0) || !(fixedBytes >= 0)) throw new Error(`${label}: bad scaling options`);
  const inputBytes = options.n * k * unitBytes + fixedBytes;
  if (inputBytes > maxInputBytes) throw new Error(`${label}: the ${k}N input is about ${Math.round(inputBytes)} bytes, over the ${maxInputBytes} byte limit. Larger inputs leave the CPU cache and CI shows a steady ratio of about 25 for linear code. Shrink N (the repeat count keeps a small N stable).`);
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
  // Calibrate on N: measure the fastest of the warm runs, and repeat the work more until that is long enough.
  let ms = fastest(small);
  while (ms < s.minSampleMs && batches < MAX_BATCHES) {
    batches = grow(batches, ms, s.minSampleMs);
    ms = fastest(small);
  }
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
  let ms = await fastest(small);
  while (ms < s.minSampleMs && batches < MAX_BATCHES) {
    batches = grow(batches, ms, s.minSampleMs);
    ms = await fastest(small);
  }
  if (ms > s.hangMs) return verdict(s.label, s, ms, ms, batches);
  const msK = await fastest(large);
  return verdict(s.label, s, ms, msK, batches);
}
