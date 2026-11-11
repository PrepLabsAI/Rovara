// A task's spec state on the document store, at the key Cloud keeps it, and the review walks recorded beside it.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SpecTargetSchema, queryAll, type SpecFile } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { specStateItem } from "../../packages/broker/src/core/spec/hooks.js";
import { documentSpecStore } from "../../packages/broker/src/core/spec/store.js";
import { specRequirementRowsOfTask, specReviewRecordItems } from "../../packages/broker/src/core/spec/review-record.js";
import { newSpecState, publishSucceeded, specStateKey, startWriting, writeSucceeded, type SpecState } from "../../packages/broker/src/core/spec/state.js";

const TASK = randomUUID();
const NOW = "2026-11-10T10:00:00.000Z";
const FILES: SpecFile[] = [{ path: ".kiro/specs/x/requirements.md", content: "- 1.1 WHEN a THE SYSTEM SHALL b\n" }];
const fresh = (): SpecState => newSpecState({ taskId: TASK, planDigest: "a".repeat(64), kind: "feature", target: SpecTargetSchema.parse({ format: "kiro" }), knowledgeCommit: "b".repeat(40), now: NOW });

describe("the spec state store", () => {
  it("keeps a state at `DEVTASK#<task>` / `SPEC#STATE`, the key Cloud uses", async () => {
    const documents = new MemoryDocumentStore();
    const store = documentSpecStore(documents);
    expect(await store.load(TASK)).toEqual({ state: undefined, corrupt: false });
    expect(await store.save(fresh(), undefined)).toBe(true);
    expect(await documents.get(specStateKey(TASK))).toMatchObject({ pk: `DEVTASK#${TASK}`, sk: "SPEC#STATE", taskId: TASK, status: "due", revision: 1 });
    expect((await store.load(TASK)).state?.status).toBe("due");
  });

  it("saves a state only over the revision it read: a second writer with the same revision loses, and nobody can create it twice", async () => {
    const store = documentSpecStore(new MemoryDocumentStore());
    const first = fresh();
    expect(await store.save(first, undefined)).toBe(true);
    expect(await store.save(first, undefined)).toBe(false);
    const writing = startWriting(first, randomUUID(), NOW)!;
    expect(await store.save(writing, first.revision)).toBe(true);
    const other = startWriting(first, randomUUID(), NOW)!;
    expect(await store.save(other, first.revision)).toBe(false);
    expect((await store.load(TASK)).state?.writeOperationId).toBe(writing.writeOperationId);
  });

  it("commits a state with the items beside it, or neither (an access fence that fails is a lost write)", async () => {
    const documents = new MemoryDocumentStore();
    const store = documentSpecStore(documents);
    const fence = { kind: "check" as const, key: { pk: "FENCE", sk: "X" }, condition: { op: "exists" as const, path: ["pk"] as const } };
    expect(await store.save(fresh(), undefined, [fence])).toBe(false);
    expect(await documents.get(specStateKey(TASK))).toBeUndefined();
    await documents.put({ item: { pk: "FENCE", sk: "X" } });
    expect(await store.save(fresh(), undefined, [fence])).toBe(true);
    expect(await store.force({ ...fresh(), revision: 5 }, [fence])).toBe(true);
  });

  it("holds the pull request when the item is not a state this release reads, and replaces it only by force", async () => {
    const documents = new MemoryDocumentStore();
    const store = documentSpecStore(documents);
    await documents.put({ item: { ...specStateKey(TASK), status: "from-the-future" } });
    expect(await store.load(TASK)).toEqual({ state: undefined, corrupt: true });
    expect(await store.save(fresh(), undefined)).toBe(false);
    expect(await store.force(fresh())).toBe(true);
    expect((await store.load(TASK)).state?.status).toBe("due");
  });

  it("builds the conditional write of a state: the revision it replaces, or none for a new one", async () => {
    const documents = new MemoryDocumentStore();
    const state = fresh();
    expect((await documents.transact([specStateItem(state, undefined)])).applied).toBe(true);
    expect((await documents.transact([specStateItem(state, undefined)])).applied).toBe(false);
    expect((await documents.transact([specStateItem({ ...state, revision: 2 }, 1)])).applied).toBe(true);
    expect((await documents.transact([specStateItem({ ...state, revision: 3 }, 1)])).applied).toBe(false);
  });
});

describe("the recorded walk of a spec by a review", () => {
  const published = (): SpecState => {
    let state = startWriting(fresh(), randomUUID(), NOW)!;
    state = writeSucceeded(state, { operationId: state.writeOperationId!, title: "T", files: FILES, requirementCount: 1 }, NOW)!;
    return publishSucceeded(state, { pullRequest: { number: 12, url: "https://examplehost.test/acme/meta/pull/12", repositoryUrl: "https://examplehost.test/acme/meta", headBranch: `agentx/${randomUUID()}`, commit: "c".repeat(40) } }, NOW)!;
  };
  const walk = (commit: string) => ({ specPath: ".kiro/specs/x", specCommit: commit, verdicts: [{ id: "1.1", verdict: "met", reason: "the test covers it", evidence: ["src/a.ts:3"] }], unanswered: ["1.2"], truncated: false });

  it("writes the walk with the review's own result, only when it is about the commit the broker recorded", async () => {
    const documents = new MemoryDocumentStore();
    const store = documentSpecStore(documents);
    const state = published();
    await store.save(state, undefined);
    const env = { store, now: () => NOW };
    const operation = { id: randomUUID(), kind: "task", workflowMode: "REVIEW" };
    const accepted = await specReviewRecordItems(env, TASK, operation, { status: "SUCCEEDED", result: { specReview: walk("c".repeat(40)) } });
    expect(accepted).toHaveLength(1);
    // Nothing is written for another commit, another mode, a failed run or no report.
    expect(await specReviewRecordItems(env, TASK, operation, { status: "SUCCEEDED", result: { specReview: walk("d".repeat(40)) } })).toEqual([]);
    expect(await specReviewRecordItems(env, TASK, { ...operation, workflowMode: "IMPLEMENT" }, { status: "SUCCEEDED", result: { specReview: walk("c".repeat(40)) } })).toEqual([]);
    expect(await specReviewRecordItems(env, TASK, operation, { status: "FAILED", result: { specReview: walk("c".repeat(40)) } })).toEqual([]);
    expect(await specReviewRecordItems(env, TASK, operation, { status: "SUCCEEDED", result: {} })).toEqual([]);
    expect(await specReviewRecordItems(env, TASK, operation, { status: "SUCCEEDED", result: { specReview: { specPath: "x" } } })).toEqual([]);
    await documents.transact([...accepted]);
    const rows = await specRequirementRowsOfTask(documents, TASK);
    expect(rows.map((row) => `${row.id}:${row.verdict}`)).toEqual(["1.1:met", "1.2:unanswered"]);
    expect(rows[0]).toMatchObject({ operationId: operation.id, recordedAt: NOW, specCommit: "c".repeat(40) });
    expect((await queryAll(documents, { pk: `DEVTASK#${TASK}`, sk: { op: "beginsWith", prefix: "SPEC#REVIEW#" } })).length).toBe(1);
  });
});
