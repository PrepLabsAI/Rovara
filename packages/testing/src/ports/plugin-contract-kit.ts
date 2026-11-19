// The shape every plug-in contract suite shares. A suite is a list of named checks over a "world" (the adapter under test, plus a driver that sets up the
// host's state). Checks are plain async functions so a test can run one directly against a deliberately broken adapter and expect it to fail: that is how a
// suite proves it can fail at all. `runContract` registers one vitest case per check, each on a fresh world.
import { describe, expect, it } from "vitest";

export interface ContractCheck<W> {
  readonly name: string;
  readonly run: (world: W) => Promise<void>;
  /** The capability (or condition) the check needs; the check is left out, with its name shown as skipped, when the world does not have it. */
  readonly needs?: (world: W) => boolean;
}

export interface ContractOptions {
  /** Checks a real adapter cannot yet run, by check name, with the reason. They show as skipped, so a gap is visible and never silent. */
  readonly skip?: Readonly<Record<string, string>>;
}

export function runContract<W>(label: string, checks: readonly ContractCheck<W>[], makeWorld: () => Promise<W> | W, options: ContractOptions = {}): void {
  describe(label, () => {
    for (const check of checks) {
      const reason = options.skip?.[check.name];
      if (reason !== undefined) {
        it.skip(`${check.name} (skipped: ${reason})`, () => undefined);
        continue;
      }
      it(check.name, async (context) => {
        const world = await makeWorld();
        // A capability the adapter does not have: the check shows as skipped, never as passed.
        if (check.needs !== undefined && !check.needs(world)) context.skip();
        await check.run(world);
      });
    }
    it("lists no skip for a check that does not exist", () => {
      const names = new Set(checks.map((check) => check.name));
      for (const name of Object.keys(options.skip ?? {})) expect(names.has(name)).toBe(true);
    });
  });
}

/** What a rejected promise threw, or undefined when it did not reject. */
export async function rejection(run: () => Promise<unknown>): Promise<{ code?: string; message: string } | undefined> {
  try {
    await run();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  return undefined;
}

export const SHA40 = /^[a-f0-9]{40}$/;
