// L4-LP2: the plan summary of the task log, from a company's own records (`planSummarySourceOf`) and on a hosted company through its own decision gate (`hostedPlanSummaryOf`). The plan is read only from the task's OWN
// stored document, only for this company's open task that waits at the plan review, and its risk is the tier the company's gate grades it at.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWorkflowSnapshot, submitWorkflowArtifact, type JsonValue, type OrgId } from "@agentx/contracts";
import { hostedPlanSummaryOf } from "../../../packages/broker/src/core-host/plan-summary.js";
import { planSummarySourceOf } from "../../../packages/broker/src/core/task-log/index.js";
import { workflowTaskKey } from "../../../packages/broker/src/core/decisions/workflow-subject.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const MARKDOWN = "# Add a cap to campaigns\n\n- Add a spend field\n- Refuse a start above it\n- Show the cap on the page\n";
const OWNER_KEY = "owner-key-a";
const WORKSPACE = "ws-a";
const OWN_KEY = `private/${OWNER_KEY}/${WORKSPACE}/plan-documents/plan-v1.md`;
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function waiting(objectKey: string, text = MARKDOWN) {
  const initial = createWorkflowSnapshot({ taskId: TASK, ownerId: "a".repeat(64), now: "2026-11-17T09:59:00.000Z" });
  return submitWorkflowArtifact(initial, {
    expectedRevision: initial.revision, now: "2026-11-17T10:00:00.000Z",
    artifact: { id: "plan-v1", type: "plan", version: 1, sha256: sha(text), producer: "agentx-planner", objectKey, createdAt: "2026-11-17T10:00:00.000Z", format: "markdown" },
  });
}

async function world(options: { company?: OrgId; objectKey?: string; closed?: boolean; text?: string; stored?: Record<string, string> } = {}) {
  const store = new MemoryDocumentStore();
  const objectKey = options.objectKey ?? OWN_KEY;
  const text = options.text ?? MARKDOWN;
  await store.put({ item: {
    ...workflowTaskKey(TASK), companyId: options.company ?? A, project: "web", ownerKey: OWNER_KEY, workspaceId: WORKSPACE, requestText: "Add a cap", runEstimate: { lowUsd: 4, highUsd: 10 },
    ...(options.closed === true ? { closedAt: "2026-11-17T11:00:00.000Z" } : {}), workflow: JSON.parse(JSON.stringify(waiting(objectKey, text))) as JsonValue,
  } });
  const objects = options.stored ?? { [OWN_KEY]: MARKDOWN, "private/another-owner/ws-b/plan-documents/plan-v1.md": MARKDOWN };
  const blobs = { get: async (key: string) => (objects[key] === undefined ? undefined : new TextEncoder().encode(objects[key])), put: async () => undefined, delete: async () => undefined };
  return { store, blobs };
}
const gate = (risk = "medium") => ({ requirement: async () => ({ requirement: { methods: ["m"], minApprovers: 1, selfApprovalAllowed: true }, risk, revision: 1, artifactDigest: "0".repeat(64) }) });

describe("the plan summary source reads the task's own plan only", () => {
  it("gives what the card says (needed, lines, the gate's risk, the estimate) for this company's open task at the plan review", async () => {
    const w = await world();
    const facts = await planSummarySourceOf({ store: w.store, artifacts: w.blobs as never, gate: gate("medium") })(A, TASK);
    expect(facts).toMatchObject({ needed: "Add a cap to campaigns", lines: ["Add a spend field", "Refuse a start above it", "Show the cap on the page"], risk: "medium", estimate: "$4 to $10" });
  });

  it("is nothing for a closed task, another company's task, or a task that waits on nothing", async () => {
    const closed = await world({ closed: true });
    expect(await planSummarySourceOf({ store: closed.store, artifacts: closed.blobs as never, gate: gate() })(A, TASK)).toBeUndefined();
    const other = await world({ company: B });
    expect(await planSummarySourceOf({ store: other.store, artifacts: other.blobs as never, gate: gate() })(A, TASK)).toBeUndefined();
    expect(await planSummarySourceOf({ store: new MemoryDocumentStore(), artifacts: other.blobs as never, gate: gate() })(A, TASK)).toBeUndefined();
  });

  it("never reads an object that is not the task's own: a pointer to another owner's document (on a bucket several companies share) reads nothing", async () => {
    const foreign = "private/another-owner/ws-b/plan-documents/plan-v1.md";
    const w = await world({ objectKey: foreign });
    const reads: string[] = [];
    const blobs = { get: async (key: string) => { reads.push(key); return new TextEncoder().encode(MARKDOWN); } };
    expect(await planSummarySourceOf({ store: w.store, artifacts: blobs as never, gate: gate() })(A, TASK)).toBeUndefined();
    expect(reads).toEqual([]);
    // The same document under the task's own prefix is read (a positive control: the read path ran).
    const own = await world();
    expect(await planSummarySourceOf({ store: own.store, artifacts: { get: async (key: string) => { reads.push(key); return new TextEncoder().encode(MARKDOWN); } } as never, gate: gate() })(A, TASK)).toBeDefined();
    expect(reads).toEqual([OWN_KEY]);
  });

  it("is nothing when the document does not match its digest", async () => {
    const w = await world({ stored: { [OWN_KEY]: "# Something else\n- changed\n- bytes\n" } });
    expect(await planSummarySourceOf({ store: w.store, artifacts: w.blobs as never, gate: gate() })(A, TASK)).toBeUndefined();
  });
});

describe("a hosted company's plan summary goes through its own decision gate", () => {
  const registryOf = (blobs: unknown, approvers: unknown = { requirement: async () => ({ methods: ["m"], minApprovers: 1, selfApprovalAllowed: true }), verify: async () => ({ ok: false }) }) => ({
    require: (name: string) => {
      if (name === "object-storage") return blobs;
      if (name === "approvers") return approvers;
      if (name === "identity") return { capabilities: {} };
      throw new Error(`no ${name}`);
    },
  });

  it("is the card's summary with the tier the gate grades it at, for this company's task", async () => {
    const w = await world();
    const flow = { store: w.store, audit: { record: async () => undefined } } as never;
    const summary = hostedPlanSummaryOf({ flow, registry: registryOf(w.blobs) as never, companyId: A, now: () => new Date("2026-11-17T12:00:00.000Z") });
    const facts = await summary(A, TASK);
    expect(facts).toMatchObject({ needed: "Add a cap to campaigns", estimate: "$4 to $10" });
    expect(["low", "medium", "high"]).toContain(facts!.risk);
  });

  it("answers nothing for a task of another company, and reads nothing for it", async () => {
    const w = await world({ company: B });
    let reads = 0;
    const registry = registryOf({ get: async () => { reads += 1; return undefined; } });
    const summary = hostedPlanSummaryOf({ flow: { store: w.store, audit: { record: async () => undefined } } as never, registry: registry as never, companyId: A, now: () => new Date() });
    expect(await summary(B, TASK)).toBeUndefined();
    expect(await summary(A, TASK)).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("a company whose gate cannot be built gets no summary (the call fails; the log's other entries are written)", async () => {
    const w = await world();
    const registry = { require: (name: string) => { if (name === "approvers") throw new Error("not wired"); return {}; } };
    const summary = hostedPlanSummaryOf({ flow: { store: w.store, audit: { record: async () => undefined } } as never, registry: registry as never, companyId: A, now: () => new Date() });
    await expect(summary(A, TASK)).rejects.toThrow();
  });
});
