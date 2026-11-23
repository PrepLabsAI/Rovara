// STOP-NON-DESTRUCTIVE census: which code can end a workspace's compute AND delete its volume, and which code can only end the instance. Deleting a volume is for a Close alone.
// The scan reads every source file under packages/broker/src (production and test-support paths alike: nothing is filtered out by its name, `core/test-env/saved-env-sweep.ts` is production code),
// counts the call sites of each deleting call and of `machines.stop`, and fails when the set changes. A new caller must be added here on purpose, with the reason it may delete.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = "packages/broker/src";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx|mts)$/u.test(name) ? [path] : [];
  });
}

/** `file: number of matches` for every file under the broker's source that has at least one. */
function census(pattern: RegExp): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of sources(ROOT)) {
    const count = [...readFileSync(file, "utf8").matchAll(pattern)].length;
    if (count > 0) found[file.slice(ROOT.length + 1)] = count;
  }
  return found;
}

describe("only a Close, a setup check, the saved-environment sweep and a dispatch orphan delete a machine's volume", () => {
  it("machines.terminate( has exactly these callers (the port's destructive call: instance AND volume)", () => {
    expect(census(/\bmachines\.terminate\(/gu)).toEqual({
      "core/setup-agent/check.ts": 1,
      "core/task-flow/close.ts": 1,
      "core/task-flow/dispatch.ts": 2,
      "core/test-env/saved-env-sweep.ts": 1,
    });
  });

  it("the session-level deleters have exactly these call sites: the adapter's terminate (a Close's), the broker's pass-through, the legacy close, and the manager's own definition", () => {
    expect(census(/\bdeleteSession\(/gu)).toEqual({
      "aws/broker.ts": 1,
      "aws/sessions.ts": 1,
      "aws/worker-machines/broker-core.ts": 1,
      "aws/worker-machines/session-worker-machines.ts": 1,
    });
    expect(census(/\bdeleteEc2Session\(/gu)).toEqual({ "aws/broker.ts": 2 });
  });

  it("machines.stop( has exactly these callers: the cancel's tail, the run-lost sweep's spend stop and the critic hold's two", () => {
    expect(census(/\bmachines\.stop\(/gu)).toEqual({
      "core/pr-feedback/quiesce.ts": 2,
      "core/task-flow/cancel-active.ts": 1,
      "core/task-flow/run-watch.ts": 1,
    });
  });

  it("finishCancellation (the cancel tail that stops the machine) has exactly these callers: cancelTask and the idle watchdog", () => {
    expect(census(/\bfinishCancellation\(/gu)).toEqual({
      "aws/core-idle-slack.ts": 1,
      "core/task-flow/cancel-active.ts": 1,
      "core/task-flow/cancel.ts": 1,
    });
  });

  it("the broker-only adapter's stop reaches neither deleteSession nor terminate: it asks the reaper to end the instance and keeps the volume", () => {
    const source = readFileSync(join(ROOT, "aws/worker-machines/session-worker-machines.ts"), "utf8");
    const start = source.indexOf("  async stop(machineId: string)");
    const stop = source.slice(start, source.indexOf("  async terminate(machineId: string)", start));
    expect(stop).toContain("requestStop(");
    expect(stop).not.toMatch(/deleteSession|\.terminate\(|terminate\(machineId\)/u);
    // The broker's composition hands the adapter the stop request, and never lets it start or end an instance itself.
    const broker = readFileSync(join(ROOT, "aws/worker-machines/broker-core.ts"), "utf8");
    expect(broker).toMatch(/requestStop: \(workspaceId\) => existingOperation\(\(\) => deps\.sessions\.requestStop\(workspaceId\)\)/u);
    expect(broker).toMatch(/claimStop: dispatchOnly/u);
    expect(broker).toMatch(/stopInstance: dispatchOnly/u);
  });
});
