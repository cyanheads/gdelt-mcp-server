/**
 * @fileoverview Thread-CPU proof that code reading caller-sized text costs time linear in its
 * length. Sizes double from 5,000 characters, and each is checked before the next is built, so a
 * quadratic regression fails within a few doublings. At every size the 5,000-character value is
 * timed again beside the larger one and the least per-character growth of five samples must stay
 * under 4× — a per-call ratio under 256 across the full 64× span — while one call stays under an
 * absolute CPU cap. The same work costs several times the CPU on one core as on another, so a
 * baseline timed once would be compared with a later size timed elsewhere; real super-linear
 * growth shows in every sample. Callers run these inside a test whose timeout is 0: vitest cannot
 * interrupt a synchronous body, so a wall-clock timeout bounds no hang.
 * @module tests/helpers/linear-cost
 */

import { expect } from 'vitest';

/** Doubling sizes spanning 64×. */
export const LINEAR_SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000] as const;

/**
 * The span for a shape that sends a regex over the value: Bun's engine can switch to a much slower
 * mode past about 80,000 characters on some shapes, so those stop there, and a shape that never
 * crosses it (a long digit run) carries the full span.
 */
export const REGEX_SAFE_SIZES = [5_000, 10_000, 20_000, 40_000, 80_000] as const;

/** A shape: its name, and how to build a value of exactly `n` characters. */
export type CostShape = readonly [
  name: string,
  build: (n: number) => string,
  sizes?: readonly number[],
];

const SAMPLES = 5;
/** Characters a synchronous sample reads, so a 5,000-character call is timed over a batch. */
const BATCH_CHARS = 40_000;

function threadMicros(): number {
  const used = process.threadCpuUsage();
  return used.user + used.system;
}

/** Assert that `run` costs time linear in the value's length for every shape. */
export function expectLinearCost(
  shapes: readonly CostShape[],
  run: (value: string) => void,
  capMicrosPerCall = 150_000,
): void {
  const perCall = (value: string) => {
    const calls = Math.max(1, Math.floor(BATCH_CHARS / value.length));
    const start = threadMicros();
    for (let call = 0; call < calls; call++) run(value);
    return (threadMicros() - start) / calls;
  };
  for (const [name, build, sizes = LINEAR_SIZES] of shapes) {
    const base = build(sizes[0] as number);
    for (const size of sizes) {
      const value = build(size);
      expect(value).toHaveLength(size);
      let fastest = Number.POSITIVE_INFINITY;
      let leastGrowth = Number.POSITIVE_INFINITY;
      for (let sample = 0; sample < SAMPLES; sample++) {
        const basePerChar = Math.max(perCall(base), 1) / base.length;
        const cost = perCall(value);
        fastest = Math.min(fastest, cost);
        leastGrowth = Math.min(leastGrowth, cost / size / basePerChar);
      }
      expect(fastest, `${name}: CPU µs per ${size}-character call`).toBeLessThan(capMicrosPerCall);
      expect(leastGrowth, `${name}: per-character cost at ${size} vs ${base.length}`).toBeLessThan(
        4,
      );
    }
  }
}

/** The asynchronous variant: one call per measurement. */
export async function expectLinearCostAsync(
  shapes: readonly CostShape[],
  run: (value: string) => Promise<void>,
  capMicrosPerCall = 150_000,
): Promise<void> {
  const once = async (value: string) => {
    const start = threadMicros();
    await run(value);
    return threadMicros() - start;
  };
  for (const [name, build, sizes = LINEAR_SIZES] of shapes) {
    const base = build(sizes[0] as number);
    for (const size of sizes) {
      const value = build(size);
      expect(value).toHaveLength(size);
      let fastest = Number.POSITIVE_INFINITY;
      let leastGrowth = Number.POSITIVE_INFINITY;
      for (let sample = 0; sample < SAMPLES; sample++) {
        const basePerChar = Math.max(await once(base), 1) / base.length;
        const cost = await once(value);
        fastest = Math.min(fastest, cost);
        leastGrowth = Math.min(leastGrowth, cost / size / basePerChar);
      }
      expect(fastest, `${name}: CPU µs per ${size}-character call`).toBeLessThan(capMicrosPerCall);
      expect(leastGrowth, `${name}: per-character cost at ${size} vs ${base.length}`).toBeLessThan(
        4,
      );
    }
  }
}

/** `unit` repeated and cut to exactly `length` characters. */
export function fill(unit: string, length: number): string {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}
