// L4-ART: the flow's `artifacts` reader on a hosted root. It answers a key only for a workspace of its OWN company (and, for the owner-keyed shape, that workspace's owner); everything
// else reads as "not there". Each guard has a test that fails without it (the mutants are listed in briefs/lead4/L4-ART-MUTANTS-20261118.md).
import { describe, expect, it, vi } from "vitest";
import type { ObjectStorage, OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { artifactObjectKey } from "../../packages/broker/src/services/callbacks.js";
import {
  artifactKeyScopeOf, createCompanyArtifactReader, type ArtifactReadRefusal,
} from "../../packages/broker/src/core-host/company-artifact-reader.js";
import { COMPANY_A_ID, COMPANY_B_ID } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A_ID as OrgId, B = COMPANY_B_ID as OrgId;
const OWNER_A = "owner-a-1111", OWNER_B = "owner-b-2222";
// The same raw workspace id in both companies: a reader that is not company-bound would find the other company's.
const SHARED = "ws-shared-1";
const A_ONLY = "ws-a-only-1";
const B_ONLY = "ws-b-only-1";
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** The object port as the S3 adapter behaves: undefined when missing or bigger than maxBytes (never cut). Every call is counted. */
function fakeBlobs(objects: Record<string, Uint8Array>) {
  const calls: Array<{ key: string; maxBytes: number }> = [];
  const blobs: Pick<ObjectStorage, "get"> = {
    async get(key, maxBytes) {
      calls.push({ key, maxBytes });
      const found = objects[key];
      return found === undefined || found.byteLength > maxBytes ? undefined : found;
    },
  };
  return { blobs, calls };
}

async function companyStore() {
  const store = new MemoryDocumentStore();
  const workspace = (companyId: OrgId, id: string, ownerKey: string) => store.put({ item: { ...workspaceKey(companyId, id), entityType: "WORKSPACE", id, companyId, orgId: companyId, ownerKey, projectName: "payments" } });
  await workspace(A, SHARED, OWNER_A);
  await workspace(B, SHARED, OWNER_B);
  await workspace(A, A_ONLY, OWNER_A);
  await workspace(B, B_ONLY, OWNER_B);
  return store;
}

const planKey = (owner: string, workspace: string) => `private/${owner}/${workspace}/plan-documents/art-1.json`;
const callbackKey = (workspace: string, operation = "op-1", name = "plan.md") => artifactObjectKey(workspace, operation, name);

/** The companies that hold a workspace record for each raw workspace id of the world. */
const HOLDERS: Record<string, OrgId[]> = { [SHARED]: [A, B], [A_ONLY]: [A], [B_ONLY]: [B] };

async function world(extra: Record<string, Uint8Array> = {}, options: { refused?: (reason: ArtifactReadRefusal) => void; unrecorded?: string[] } = {}) {
  const objects: Record<string, Uint8Array> = {
    [planKey(OWNER_A, SHARED)]: text("a-shared-plan"), [planKey(OWNER_B, SHARED)]: text("b-shared-plan"),
    [planKey(OWNER_A, A_ONLY)]: text("a-only-plan"), [planKey(OWNER_B, B_ONLY)]: text("b-only-plan"),
    [callbackKey(SHARED)]: text("a-shared-callback"), [callbackKey(A_ONLY)]: text("a-only-callback"), [callbackKey(B_ONLY)]: text("b-only-callback"),
    ...extra,
  };
  const { blobs, calls } = fakeBlobs(objects);
  const store = await companyStore();
  // The engine records each worker artifact as an ARTIFACT row of its workspace (services/callbacks.ts): every callback-shaped object of the world has its row, in each company that holds the workspace.
  for (const key of Object.keys(objects)) {
    const scope = artifactKeyScopeOf(key);
    if (scope?.form !== "operation" || (options.unrecorded ?? []).includes(key)) continue;
    for (const companyId of HOLDERS[scope.workspaceId] ?? []) await store.put({ item: { ...workspaceKey(companyId, scope.workspaceId), sk: `ARTIFACT#${scope.operationId}#${scope.name}`, entityType: "ARTIFACT", objectKey: key } });
  }
  const readerOf = (companyId: OrgId) => createCompanyArtifactReader({ blobs, store, companyId, ...(options.refused === undefined ? {} : { refused: options.refused }) });
  return { reader: readerOf(A), readerOf, calls, store, objects };
}
const decode = (bytes: Uint8Array | undefined): string | undefined => (bytes === undefined ? undefined : new TextDecoder().decode(bytes));

describe("the hosted artifacts reader: what it reads", () => {
  it("reads a task document of its own company's workspace, in both shapes the engine writes (a replaceable artifact's key carries its digest as one more part)", async () => {
    const replaceable = `${callbackKey(A_ONLY, "op-1", "eval-round.json")}/${"a".repeat(64)}`;
    const w = await world({ [replaceable]: text("round") });
    expect(decode(await w.reader.get(planKey(OWNER_A, A_ONLY), 1000))).toBe("a-only-plan");
    expect(decode(await w.reader.get(callbackKey(A_ONLY), 1000))).toBe("a-only-callback");
    expect(decode(await w.reader.get(replaceable, 1000))).toBe("round");
  });
});

describe("the hosted artifacts reader: only the flow's own key shapes", () => {
  it.each([
    ["an install-wide key", "private/org_aaaaaaaaaaaaaaaaaaaa/fixtures/x.json"],
    ["another point's key", "evidence/pack/x"],
    ["the workflow admissions folder", "workflow-e2e-admissions/sha256/abc.json"],
    ["a private key with no document part", `private/${OWNER_A}/${A_ONLY}`],
    ["a workspace key that is not an operation's", `workspaces/${A_ONLY}/other/op-1/plan.md`],
    ["a workspace key with no name", `workspaces/${A_ONLY}/operations/op-1`],
    ["a dot part", `private/${OWNER_A}/${A_ONLY}/../${A_ONLY}/x`],
    ["a single dot part", `private/${OWNER_A}/${A_ONLY}/./x`],
    ["a doubled slash", `private/${OWNER_A}//${A_ONLY}/x`],
    ["a leading slash", `/private/${OWNER_A}/${A_ONLY}/x`],
    ["a trailing slash", `private/${OWNER_A}/${A_ONLY}/x/`],
    ["a percent-encoded dot part", `private/${OWNER_A}/${A_ONLY}/%2e%2e/x`],
    ["a backslash", `private\\${OWNER_A}\\${A_ONLY}\\x`],
    ["a space", `private/${OWNER_A}/${A_ONLY}/a b`],
    ["a key as long as the port allows plus one", `private/${OWNER_A}/${A_ONLY}/${"a".repeat(1100)}`],
    ["an empty key", ""],
    ["an operation id with a dot", `workspaces/${A_ONLY}/operations/op.1/plan.md`],
    ["an owner key with a colon", `private/owner:a/${A_ONLY}/x`],
    ["a workspace id with a dot", `private/${OWNER_A}/ws.a/x`],
    ["a workspace key with too many parts", `workspaces/${A_ONLY}/operations/op-1/plan.md/${"a".repeat(64)}/more`],
  ])("refuses %s and never asks the object store", async (_name, key) => {
    const w = await world();
    w.calls.length = 0;
    expect(await w.reader.get(key, 1000)).toBeUndefined();
    expect(w.calls).toEqual([]);
  });

  it.each([
    `workspaces/${A_ONLY}/operations/op.1/plan.md`, `private/owner:a/${A_ONLY}/x`, `private/${OWNER_A}/ws.a/x`, `workspaces/ws=1/operations/op-1/plan.md`,
  ])("never asks the company's store about a key whose parts are not plain ids (%s)", async (key) => {
    const w = await world();
    let reads = 0;
    const store = { get: async (...args: Parameters<typeof w.store.get>) => { reads++; return await w.store.get(...args); } };
    expect(await createCompanyArtifactReader({ blobs: fakeBlobs(w.objects).blobs, store, companyId: A }).get(key, 1000)).toBeUndefined();
    expect(reads).toBe(0);
  });
});

describe("the hosted artifacts reader: the size bound", () => {

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1000" as never, undefined as never, null as never])("refuses a limit that is not a positive whole number (%s) without asking the store", async (limit) => {
    const w = await world();
    w.calls.length = 0;
    expect(await w.reader.get(planKey(OWNER_A, A_ONLY), limit)).toBeUndefined();
    expect(w.calls).toEqual([]);
  });

  it("refuses bytes the object store hands back above the limit (a port that did not hold its own bound)", async () => {
    const store = await companyStore();
    const lying: Pick<ObjectStorage, "get"> = { get: async () => new Uint8Array(2000) };
    const reader = createCompanyArtifactReader({ blobs: lying, store, companyId: A });
    expect(await reader.get(planKey(OWNER_A, A_ONLY), 1000)).toBeUndefined();
    const notBytes: Pick<ObjectStorage, "get"> = { get: async () => "text" as never };
    expect(await createCompanyArtifactReader({ blobs: notBytes, store, companyId: A }).get(planKey(OWNER_A, A_ONLY), 1000)).toBeUndefined();
  });
});

describe("the hosted artifacts reader: fails closed and says nothing", () => {

  it("reports only fixed reason words: never the key, the company, a workspace or a cause", async () => {
    const seen: string[] = [];
    const w = await world({}, { refused: (reason) => seen.push(reason) });
    await w.reader.get(planKey(OWNER_B, B_ONLY), 1000);
    await w.reader.get(planKey(OWNER_B, SHARED), 1000);
    await w.reader.get("private/x", 1000);
    await w.reader.get(planKey(OWNER_A, A_ONLY), 0);
    expect(seen).toEqual(["workspace_not_company", "owner_mismatch", "key_not_task_document", "bad_request"]);
    const all = seen.join(" ");
    for (const secret of [OWNER_A, OWNER_B, A_ONLY, B_ONLY, SHARED, COMPANY_A_ID, COMPANY_B_ID]) expect(all).not.toContain(secret);
  });

  it("is not changed by a refusal hook that throws", async () => {
    const hook = vi.fn(() => { throw new Error("log down"); });
    const w = await world({}, { refused: hook });
    await expect(w.reader.get(planKey(OWNER_B, B_ONLY), 1000)).resolves.toBeUndefined();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(decode(await w.reader.get(planKey(OWNER_A, A_ONLY), 1000))).toBe("a-only-plan");
  });
});
