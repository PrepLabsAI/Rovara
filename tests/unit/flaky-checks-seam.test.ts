// TE-C6: the broker's seam that reads the worker's flaky-rerun.json. A store that lists the file twice (Cloud's can: the same name from two uploads) is never read as "the first" or "the last": nothing is excused.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CheckEntry, ObjectStorage } from "@agentx/contracts";
import { createLocalFlakyChecks } from "../../packages/broker/src/local/app/flaky-checks.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import type { OperationRecord, TaskRecord } from "../../packages/broker/src/core/task-flow/records.js";

const ID = "tests/test_cart.py::test_total";
const task = { ownerKey: "owner", workspaceId: "ws1", taskId: "t1", project: "payments" } as unknown as TaskRecord;
const operation = { id: "op1" } as unknown as OperationRecord;
const failed: CheckEntry = { id: "readiness:0", label: "pytest", source: "project", before: "passed", after: "failed", class: "regression", output: "", durationMs: 5, exitCode: 1 };
const file = (flaky: string[]) => JSON.stringify({ schemaVersion: 1, checks: [{ checkId: "readiness:0", flaky }] });

async function world(files: string[]) {
  const blobs = new Map<string, Uint8Array>();
  const store = new MemoryDocumentStore();
  for (const [index, text] of files.entries()) {
    const bytes = new TextEncoder().encode(text);
    const objectKey = `objects/${String(index)}`;
    blobs.set(objectKey, bytes);
    await store.put({ item: { pk: "WORKSPACE#ws1", sk: `ARTIFACT#op1#flaky${String(index)}`, name: "flaky-rerun.json", objectKey, sha256: createHash("sha256").update(bytes).digest("hex") } });
  }
  const storage = { get: async (key: string) => blobs.get(key) } as unknown as ObjectStorage;
  const seam = createLocalFlakyChecks({ flow: { store, companyId: "org" }, blobs: storage, testEnv: { store, now: () => Date.now() }, env: { ROVARA_FLAKY_RERUN: "1" } });
  return () => seam({ task, operation, candidateDigest: "d".repeat(64), checks: [failed] });
}

describe("the flaky-rerun seam", () => {
  it("one file names the check: it is excused", async () => {
    const found = await (await world([file([ID])]))();
    expect([...(found?.byCheck ?? [])]).toEqual([["readiness:0", [ID]]]);
  });

  it("two files with the same name on one operation: nothing is excused, whatever they say", async () => {
    expect(await (await world([file([ID]), file([ID])]))()).toBeUndefined();
    expect(await (await world([file([ID]), file(["tests/other.py::test_y"])]))()).toBeUndefined();
  });

  it("no file: nothing is excused", async () => {
    expect(await (await world([]))()).toBeUndefined();
  });
});
