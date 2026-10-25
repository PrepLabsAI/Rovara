import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXECUTOR_RUN_LOCK_PATH, withExecutorRunLock } from "../support/executor-run-lock.js";

// F5: the real executor runs share the fixed forwarder port, so the files that run them take turns.
describe("the executor run lock", () => {
  it("lets one holder at a time in, and runs the next when the first is done, even when the first fails", async () => {
    const events: string[] = [];
    const hold = (name: string, ms: number, fail = false) => withExecutorRunLock(async () => {
      events.push(`${name}:in`);
      await new Promise((done) => setTimeout(done, ms));
      events.push(`${name}:out`);
      if (fail) throw new Error(`${name} failed`);
      return name;
    });
    const results = await Promise.allSettled([hold("a", 120, true), hold("b", 20), hold("c", 20)]);
    expect(results.map((item) => item.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    // Whatever the order they were let in, each leaves before the next enters.
    for (let index = 0; index < events.length; index += 2) expect(events[index]!.endsWith(":in") && events[index + 1] === events[index]!.replace(":in", ":out")).toBe(true);
  });

  it("takes over a lock whose owner is gone", async () => {
    await mkdir(EXECUTOR_RUN_LOCK_PATH, { recursive: true });
    await writeFile(join(EXECUTOR_RUN_LOCK_PATH, "owner"), "2147483646");
    await expect(withExecutorRunLock(async () => "ran")).resolves.toBe("ran");
  });
});
