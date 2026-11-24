// REVIEW (Opus, DEC 254zzz447): the setup WARNING now writes the `setup_paused#<key>` claim in the thread for a task that is NOT paused. `setupPausedPosted` still reads "BLOCKED (any reason) + claim done" as
// "the thread was told about the pause", so a task that later blocks for ANOTHER reason (stuck, questions) loses its needs-you reminder in the conversation it came from. Reproduction of the review finding.
import { describe, expect, it } from "vitest";
import type { DocumentStore, OrgId, StoredDocument } from "@agentx/contracts";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { driftTaskKey, recheckRowKey, setupBrokenTaskWords } from "../../packages/broker/src/core/setup-agent/recheck-rows.js";
import { setupPausedPosted } from "../../packages/broker/src/core/channel/thread-notices.js";
import { taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { COMPANY } from "../support/task-flow-harness.js";
import { ThreadWorld } from "./support/setup-cards-thread-world.js";

const KEY = "a".repeat(48);
const STEP = "setup: npm ci - setup step 0 (npm ci) failed: exit 1";
const at = "2026-11-17T10:00:00.000Z";
async function brokenLink(store: DocumentStore, orgId: OrgId, taskId: string): Promise<void> {
  await store.put({ item: JSON.parse(JSON.stringify({ ...recheckRowKey(orgId, "payments", KEY), entityType: "SETUP_RECHECK", orgId, project: "payments", key: KEY, setupRevision: 1, commits: { demo: "c1" }, classes: ["lockfile"], state: "broken", attempt: 2, check: { workspaceId: "ws-1", revision: 1, startedAt: at, startedBy: "system" }, startedAt: at, failedStep: STEP })) as StoredDocument });
  await store.put({ item: JSON.parse(JSON.stringify({ ...driftTaskKey(orgId, "payments", taskId), entityType: "SETUP_DRIFT_TASK", orgId, project: "payments", taskId, recheckKey: KEY, state: "released", at, releasedAt: at })) as StoredDocument });
}

describe("REVIEW: the setup warning must not swallow a later needs-you reminder in the thread", () => {
  const session = { orgId: COMPANY, sessionId: taskSessionId(ThreadWorld.TASK), subject: { kind: "task", taskId: ThreadWorld.TASK } } as never;
  const blockWith = async (w: ThreadWorld, blockReason: string) => { await w.store.update({ key: taskKey(ThreadWorld.TASK), ops: [{ op: "set", path: ["workflow"], value: { state: "BLOCKED", stage: "IMPLEMENT", revision: 3, blockReason } }] }); };

  it("a task warned at Build that later blocks for another reason is NOT 'already told' (its reminder must reach the thread)", async () => {
    const w = await ThreadWorld.make();
    await brokenLink(w.store, COMPANY, ThreadWorld.TASK);
    await w.handler.on({ kind: "setup_paused", orgId: COMPANY, taskId: ThreadWorld.TASK, at, text: "x" });
    await blockWith(w, "The checks failed three times; Rovara needs you to look.");
    expect(await setupPausedPosted({ store: w.store })(session)).toBe(false);
  });

  it("a task still paused by the OLD setup words (written before DEC 254zzz447) is still 'already told'", async () => {
    const w = await ThreadWorld.make();
    await brokenLink(w.store, COMPANY, ThreadWorld.TASK);
    await w.handler.on({ kind: "setup_paused", orgId: COMPANY, taskId: ThreadWorld.TASK, at, text: "x" });
    await blockWith(w, setupBrokenTaskWords(STEP));
    expect(await setupPausedPosted({ store: w.store })(session)).toBe(true);
  });
});
