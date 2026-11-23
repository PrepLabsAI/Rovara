// F1 (Opus review of W1): a person's Merge press wakes the tracking row so the sweep records the merge; a failing row's backoff must not delay it. A background wake (a webhook) still waits.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { change } from "@agentx/contracts";
import { host } from "../support/service-host.js";
import { TASK_ID } from "../support/merge-world.js";
import { recoveryRowKey } from "../../packages/broker/src/core/merge/store.js";
import { wakeMergeTracking, wakeMergeTrackingForPerson } from "../../packages/broker/src/services/merge-tracking.js";

it("a person's wake makes a failing row due at once; the background wake of the same row waits out its failure", async () => {
  const w = await host();
  const now = w.clock.ms;
  const failing = { attempts: 3, lastAttemptAt: now, nextAttemptAt: now + 180_000 };
  const set = () => w.h.store.update({ key: recoveryRowKey(TASK_ID), ops: Object.entries(failing).map(([name, value]) => change.set(name, value)) });
  await set();
  await wakeMergeTracking(w.h.store, TASK_ID, now);
  expect((await w.h.store.get(recoveryRowKey(TASK_ID)))!["nextAttemptAt"]).toBe(now + 180_000);
  await wakeMergeTrackingForPerson(w.h.store, TASK_ID, now);
  expect(await w.h.store.get(recoveryRowKey(TASK_ID))).toMatchObject({ nextAttemptAt: now, lastHintAt: now });
});

it("the hosted root wires the Merge press's wake as a person's wake (not the background one)", () => {
  const source = readFileSync(new URL("../../packages/broker/src/aws/core-engine-root.ts", import.meta.url), "utf8");
  expect(source).toMatch(/afterMerge: \(taskId\) => wakeMergeTrackingForPerson\(/u);
  expect(source).not.toMatch(/\bwakeMergeTracking\(/u);
});
