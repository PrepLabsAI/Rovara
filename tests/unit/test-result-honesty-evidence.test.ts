// TEST-RESULT-HONESTY: the task's evidence pack says what a pass did not test, and says which test-environment words apply when the project's approved environment was not used (the pin's words, not the generic ones).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectRevisionKey, type CheckEntry } from "../../packages/contracts/src/index.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { createLocalEvidence } from "../../packages/broker/src/local/app/evidence.js";
import { testEnvPinItem } from "../../packages/broker/src/core/test-env/usable.js";

const ORG = `org_${"a".repeat(20)}`;
const PROJECT = "payments";
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const DIGEST = "c".repeat(64);
const TASK = { companyId: ORG, ownerKey: "owner-1", workspaceId: "ws-1", taskId: "task-1", project: PROJECT };
const PYTEST_ALL = "============================== 5 skipped in 0.11s ==============================\n";
const entry = (output: string): CheckEntry => ({ id: "readiness:0", label: "pytest -q", source: "project", before: "passed", after: "passed", class: "passing", output, durationMs: 700, exitCode: 0 });

async function world(pin?: { reason: "dependencies_unavailable_workers" | "dependencies_not_connected" }) {
  const store = new MemoryDocumentStore();
  const blobs = createDocumentObjectStorage(store, { companyId: ORG, now: () => NOW });
  const text = JSON.stringify({ schemaVersion: 1, candidateDigest: DIGEST, checks: [] });
  const rawKey = "private/owner-1/ws-1/op-1/evidence-raw.json";
  await blobs.put(rawKey, Buffer.from(text), { contentType: "application/json", metadata: {}, retention: "evidence-std" });
  await store.put({ item: { pk: workspaceKey(ORG, "ws-1").pk, sk: "ARTIFACT#op-1#evidence-raw.json", name: "evidence-raw.json", objectKey: rawKey, sha256: createHash("sha256").update(text).digest("hex") } });
  await store.put({ item: { ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", definition: { name: PROJECT, revision: 1, repositories: [{ name: "r", url: "https://example.invalid/r.git", path: "r", defaultBranch: "main", credentialRef: "c" }] } } });
  if (pin !== undefined) {
    const item = testEnvPinItem({ orgId: ORG, project: PROJECT, taskId: "task-1", nowMs: NOW, unused: { revision: 2, digest: "d".repeat(64), reason: pin.reason } });
    await store.put({ item: (item as unknown as { item: never }).item });
  }
  const evidence = createLocalEvidence({ flow: { store, companyId: ORG, log: () => undefined }, blobs });
  const keep = async (checks: CheckEntry[]) => {
    const kept = await evidence.keepAfterChecks({ task: TASK as never, operation: { id: "op-1", dispatch: { kind: "task", projectRevision: 1, payload: {} } } as never, workflow: {} as never, candidateDigest: DIGEST, checks });
    expect(kept).toMatchObject({ kept: true });
    return (await evidence.packOf(TASK, DIGEST))!;
  };
  return { keep };
}

describe("the evidence the task keeps", () => {
  it("lists a check in which every test was skipped as not tested", async () => {
    const pack = await (await world()).keep([entry(PYTEST_ALL)]);
    expect(pack.notTested).toContainEqual({ kind: "check", id: "skipped:readiness:0", text: "pytest -q: every test was skipped", reason: "not tested" });
  });
  it("says nothing extra for a plain pass", async () => {
    const pack = await (await world()).keep([entry("9 passed in 0.4s")]);
    expect(pack.notTested.map((item) => item.id)).toEqual(["test_environment"]);
  });
  it("names the test-environment words the pin recorded instead of the generic line", async () => {
    const pack = await (await world({ reason: "dependencies_unavailable_workers" })).keep([entry("9 passed in 0.4s")]);
    const environment = pack.notTested.find((item) => item.id === "test_environment");
    expect(environment).toEqual({ kind: "environment", id: "test_environment", text: "Test services not available here: this install's workers cannot start them yet; the project's own test setup was used", reason: "not applied" });
  });
  it("names the other recorded reasons too, and keeps the generic line when there is no pin", async () => {
    const pack = await (await world({ reason: "dependencies_not_connected" })).keep([entry("ok")]);
    expect(pack.notTested.find((item) => item.id === "test_environment")?.text).toBe("The approved test environment lists dependencies, which tasks do not start yet; the project's own test setup was used");
    const plain = await (await world()).keep([entry("ok")]);
    expect(plain.notTested.find((item) => item.id === "test_environment")?.text).toBe("No approved test environment: the project's own test setup was used");
  });
});
