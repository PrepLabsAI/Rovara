// L4-ART: the flow's `artifacts` reader on a hosted root. It answers a key only for a workspace of its OWN company (and, for the owner-keyed shape, that workspace's owner); everything
// else reads as "not there". Each guard has a test that fails without it (the mutants are listed in briefs/lead4/L4-ART-MUTANTS-20261118.md).
import { describe, expect, it, vi } from "vitest";
import type { ObjectStorage, OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { artifactObjectKey } from "../../packages/broker/src/services/callbacks.js";
import {
  COMPANY_ARTIFACT_READ_MAX_BYTES, artifactKeyScopeOf, createCompanyArtifactReader, type ArtifactReadRefusal,
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

  it("answers a missing object with undefined and a stored one with exactly its bytes", async () => {
    const w = await world({ [`${callbackKey(A_ONLY, "op-2", "x.json")}`]: text("{}") });
    expect(await w.reader.get(planKey(OWNER_A, A_ONLY).replace("art-1", "art-404"), 1000)).toBeUndefined();
    expect(decode(await w.reader.get(callbackKey(A_ONLY, "op-2", "x.json"), 1000))).toBe("{}");
  });
});

describe("the hosted artifacts reader: another company is never read", () => {
  it("reads the same raw workspace id only in its own company: B's reader never sees A's object and A's never sees B's", async () => {
    const w = await world();
    const b = w.readerOf(B);
    expect(decode(await w.reader.get(planKey(OWNER_A, SHARED), 1000))).toBe("a-shared-plan");
    expect(decode(await b.get(planKey(OWNER_B, SHARED), 1000))).toBe("b-shared-plan");
    // A's reader given B's owner key for the shared workspace id: the workspace is A's, the owner is not
    expect(await w.reader.get(planKey(OWNER_B, SHARED), 1000)).toBeUndefined();
    expect(await b.get(planKey(OWNER_A, SHARED), 1000)).toBeUndefined();
  });

  it("refuses a key that names another company's workspace, before the object store is asked", async () => {
    const w = await world();
    w.calls.length = 0;
    expect(await w.reader.get(planKey(OWNER_B, B_ONLY), 1000)).toBeUndefined();
    expect(await w.reader.get(callbackKey(B_ONLY), 1000)).toBeUndefined();
    expect(await w.readerOf(B).get(callbackKey(A_ONLY), 1000)).toBeUndefined();
    expect(w.calls).toEqual([]);
  });

  it("refuses a callback-shaped key of one of its own workspaces that nobody recorded: S3 keys carry no company, so the company's own ARTIFACT row must name exactly this key", async () => {
    const ghost = callbackKey(A_ONLY, "op-9", "ghost.json");
    const w = await world({ [ghost]: text("planted") }, { unrecorded: [ghost] });
    w.calls.length = 0;
    expect(await w.reader.get(ghost, 1000)).toBeUndefined();
    expect(w.calls).toEqual([]);
    // a row that names another key does not bless this one
    await w.store.put({ item: { ...workspaceKey(A, A_ONLY), sk: "ARTIFACT#op-9#ghost.json", entityType: "ARTIFACT", objectKey: callbackKey(A_ONLY, "op-9", "other.json") } });
    expect(await w.reader.get(ghost, 1000)).toBeUndefined();
  });

  it("a workspace id that two companies both hold reads, for a callback-shaped key, only where that company recorded the artifact", async () => {
    const shared = callbackKey(SHARED);
    const w = await world();
    await w.store.delete({ key: { ...workspaceKey(B, SHARED), sk: "ARTIFACT#op-1#plan.md" } });
    expect(decode(await w.reader.get(shared, 1000))).toBe("a-shared-callback");
    expect(await w.readerOf(B).get(shared, 1000)).toBeUndefined();
  });

  it("refuses a record stored under one workspace id that says it is another (the key names the record it finds)", async () => {
    const w = await world();
    await w.store.put({ item: { ...workspaceKey(A, "ws-x"), entityType: "WORKSPACE", id: "ws-y", companyId: A, orgId: A, ownerKey: "owner-x" } });
    const { blobs } = fakeBlobs({ "private/owner-x/ws-x/plan.json": text("x") });
    expect(await createCompanyArtifactReader({ blobs, store: w.store, companyId: A }).get("private/owner-x/ws-x/plan.json", 1000)).toBeUndefined();
  });

  it("refuses a key of a workspace nobody started (no record binds it to a company)", async () => {
    const w = await world({ [planKey("owner-x", "ws-ghost")]: text("ghost"), [callbackKey("ws-ghost")]: text("ghost") });
    expect(await w.reader.get(planKey("owner-x", "ws-ghost"), 1000)).toBeUndefined();
    expect(await w.reader.get(callbackKey("ws-ghost"), 1000)).toBeUndefined();
  });

  it("refuses an owner-keyed key whose owner is not the workspace's, even inside the same company", async () => {
    const w = await world({ [planKey("someone-else", A_ONLY)]: text("not yours") });
    expect(await w.reader.get(planKey("someone-else", A_ONLY), 1000)).toBeUndefined();
  });

  it("does not follow a workspace record that carries another company's name", async () => {
    const w = await world({ [planKey("owner-c", "ws-forged")]: text("forged") });
    // A record under A's partition that says it belongs to B: `locateWorkspace` and the reader's own check both refuse it
    await w.store.put({ item: { ...workspaceKey(A, "ws-forged"), entityType: "WORKSPACE", id: "ws-forged", companyId: B, orgId: B, ownerKey: "owner-c" } });
    expect(await w.reader.get(planKey("owner-c", "ws-forged"), 1000)).toBeUndefined();
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

  it("refuses a key that is not a string, never throwing", async () => {
    const w = await world();
    for (const key of [undefined, null, 5, {}, [], ["private", OWNER_A, A_ONLY, "x"]]) {
      await expect(w.reader.get(key as never, 1000)).resolves.toBeUndefined();
    }
    expect(w.calls).toEqual([]);
  });

  it("reads the scope of a key as pure text", () => {
    expect(artifactKeyScopeOf(planKey(OWNER_A, A_ONLY))).toEqual({ form: "owner", ownerKey: OWNER_A, workspaceId: A_ONLY });
    expect(artifactKeyScopeOf(callbackKey(A_ONLY))).toEqual({ form: "operation", workspaceId: A_ONLY, operationId: "op-1", name: "plan.md" });
    expect(artifactKeyScopeOf("private/a/b")).toBeUndefined();
    expect(artifactKeyScopeOf("workspaces/a/operations/b")).toBeUndefined();
  });
});

describe("the hosted artifacts reader: the size bound", () => {
  it("passes the caller's limit through, and an object bigger than it reads as not there (never cut)", async () => {
    const w = await world({ [callbackKey(A_ONLY, "op-3", "big.json")]: new Uint8Array(500) });
    w.calls.length = 0;
    expect(await w.reader.get(callbackKey(A_ONLY, "op-3", "big.json"), 499)).toBeUndefined();
    expect((await w.reader.get(callbackKey(A_ONLY, "op-3", "big.json"), 500))?.byteLength).toBe(500);
    expect(w.calls.map((call) => call.maxBytes)).toEqual([499, 500]);
  });

  it("holds a caller that asks for more than the bound to the bound", async () => {
    const w = await world({ [callbackKey(A_ONLY, "op-4", "huge.json")]: new Uint8Array(COMPANY_ARTIFACT_READ_MAX_BYTES + 1) });
    w.calls.length = 0;
    expect(await w.reader.get(callbackKey(A_ONLY, "op-4", "huge.json"), Number.MAX_SAFE_INTEGER)).toBeUndefined();
    expect(w.calls.map((call) => call.maxBytes)).toEqual([COMPANY_ARTIFACT_READ_MAX_BYTES]);
  });

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
  it("answers undefined, never throws, when the company's store or the object store cannot answer", async () => {
    const refusals: ArtifactReadRefusal[] = [];
    const store = await companyStore();
    const down = { get: async () => { throw new Error("secret-store-detail"); } };
    expect(await createCompanyArtifactReader({ blobs: fakeBlobs({}).blobs, store: down, companyId: A, refused: (reason) => refusals.push(reason) }).get(planKey(OWNER_A, A_ONLY), 1000)).toBeUndefined();
    const objectsDown = { get: async () => { throw new Error("secret-object-detail"); } };
    expect(await createCompanyArtifactReader({ blobs: objectsDown, store, companyId: A, refused: (reason) => refusals.push(reason) }).get(planKey(OWNER_A, A_ONLY), 1000)).toBeUndefined();
    expect(refusals).toEqual(["storage_unavailable", "storage_unavailable"]);
  });

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

  it("reads the workspace record at the time of each read, with no cache: a record that is gone refuses at once", async () => {
    const w = await world();
    expect(decode(await w.reader.get(planKey(OWNER_A, A_ONLY), 1000))).toBe("a-only-plan");
    await w.store.delete({ key: workspaceKey(A, A_ONLY) });
    expect(await w.reader.get(planKey(OWNER_A, A_ONLY), 1000)).toBeUndefined();
  });
});
