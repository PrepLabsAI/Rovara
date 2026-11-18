// L4-HW4: the object storage a hosted company's evidence is kept in. The shared bucket is never handed over as it is: a key must name a workspace of THIS company (and its owner), and the keeper may write,
// stat and delete only its own two folders. Anything else is refused in fixed words that never carry the key.
import { describe, expect, it } from "vitest";
import { ObjectKeyError, type ObjectMeta, type ObjectStorage, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { COMPANY_EVIDENCE_READ_MAX_BYTES, EVIDENCE_STORE_REFUSAL, createCompanyEvidenceBlobs } from "../../packages/broker/src/core-host/company-evidence-blobs.js";
import { COMPANY_ARTIFACT_READ_MAX_BYTES, createCompanyArtifactReader } from "../../packages/broker/src/core-host/company-artifact-reader.js";
import { artifactObjectKey } from "../../packages/broker/src/services/callbacks.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId, B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const META: ObjectMeta = { contentType: "application/json", metadata: {}, retention: "evidence-std" };
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array | undefined): string | undefined => (value === undefined ? undefined : new TextDecoder().decode(value));
const PACK = "private/owner-a/ws-a/evidence-pack/task-1/" + "c".repeat(64) + ".json";

/** One bucket for every company (as S3 is), every call counted; `down` makes the company's store throw. */
function world() {
  const objects = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const raw: ObjectStorage = {
    async put(key, body) { calls.push(`put ${key}`); objects.set(key, body); },
    async get(key, max) { calls.push(`get ${key}`); const found = objects.get(key); return found === undefined || found.byteLength > max ? undefined : found; },
    async stat(key) { calls.push(`stat ${key}`); const found = objects.get(key); return found === undefined ? undefined : { bytes: found.byteLength, metadata: {} }; },
    async delete(key) { calls.push(`delete ${key}`); objects.delete(key); },
    async deletePrefix(prefix) { calls.push(`deletePrefix ${prefix}`); return true; },
  };
  const store = new MemoryDocumentStore();
  const state = { down: false };
  const guarded = { async get(key: Parameters<MemoryDocumentStore["get"]>[0]) { if (state.down) throw new Error("store down"); return store.get(key); } };
  const refusals: string[] = [];
  const workspace = (companyId: OrgId, id: string, ownerKey: string) => store.put({ item: { ...workspaceKey(companyId, id), entityType: "WORKSPACE", id, companyId, orgId: companyId, ownerKey, projectName: "payments" } });
  const blobsOf = (companyId: OrgId) => createCompanyEvidenceBlobs({ blobs: raw, store: guarded, companyId, refused: (reason) => refusals.push(reason) });
  return { objects, calls, raw, store, state, refusals, workspace, blobsOf };
}

describe("a company's evidence store", () => {
  it("writes, reads, stats and deletes the pack of its own workspace", async () => {
    const w = world(); await w.workspace(A, "ws-a", "owner-a");
    const blobs = w.blobsOf(A);
    await blobs.put(PACK, bytes("{\"pack\":1}"), META, { overwrite: true });
    expect(text(await blobs.get(PACK, 1_000))).toBe("{\"pack\":1}");
    expect(await blobs.stat(PACK)).toEqual({ bytes: 10, metadata: {} });
    await blobs.delete(PACK);
    expect(await blobs.get(PACK, 1_000)).toBeUndefined();
    // the tails and the baseline words are the same two folders
    await blobs.put(`private/owner-a/ws-a/evidence/task-1/${"d".repeat(64)}`, bytes("tail"), META, { overwrite: true });
    await blobs.put(`private/owner-a/ws-a/evidence-pack/task-1/${"c".repeat(64)}.baseline.json`, bytes("{}"), META, { overwrite: true });
    expect(w.objects.size).toBe(2);
  });

  it("refuses a write for another company's workspace, even for the same raw workspace id, and stores nothing", async () => {
    const w = world(); await w.workspace(B, "ws-b", "owner-b"); await w.workspace(A, "ws-shared", "owner-a"); await w.workspace(B, "ws-shared", "owner-b");
    const a = w.blobsOf(A);
    await expect(a.put("private/owner-b/ws-b/evidence-pack/task-1/" + "c".repeat(64) + ".json", bytes("x"), META, { overwrite: true })).rejects.toThrow(ObjectKeyError);
    // The same raw workspace id exists in both companies: each is held to its own record's owner.
    await expect(a.put("private/owner-b/ws-shared/evidence-pack/task-1/" + "c".repeat(64) + ".json", bytes("x"), META, { overwrite: true })).rejects.toThrow(EVIDENCE_STORE_REFUSAL);
    await a.put("private/owner-a/ws-shared/evidence-pack/task-1/" + "c".repeat(64) + ".json", bytes("mine"), META, { overwrite: true });
    expect([...w.objects.keys()]).toEqual(["private/owner-a/ws-shared/evidence-pack/task-1/" + "c".repeat(64) + ".json"]);
    expect(w.refusals).toEqual(["workspace_not_company", "owner_mismatch"]);
  });

  it("refuses another owner's key in a workspace of the company, a workspace it has no record of, and a workspace record whose owner differs", async () => {
    const w = world(); await w.workspace(A, "ws-a", "owner-a");
    const a = w.blobsOf(A);
    await expect(a.put("private/owner-x/ws-a/evidence-pack/task-1/" + "c".repeat(64) + ".json", bytes("x"), META)).rejects.toThrow(EVIDENCE_STORE_REFUSAL);
    await expect(a.put("private/owner-a/ws-none/evidence-pack/task-1/" + "c".repeat(64) + ".json", bytes("x"), META)).rejects.toThrow(EVIDENCE_STORE_REFUSAL);
    expect(w.objects.size).toBe(0);
  });

  it("writes only the keeper's two folders: a plan document, a callback-shaped key, an install-wide key and a malformed key are refused", async () => {
    const w = world(); await w.workspace(A, "ws-a", "owner-a");
    const a = w.blobsOf(A);
    for (const key of ["private/owner-a/ws-a/plan-documents/art-1.json", "private/owner-a/ws-a/op-1/evidence-raw.json", artifactObjectKey("ws-a", "op-1", "evidence-raw.json"), "evals/x.json", "private/owner-a/ws-a", "private/owner-a/ws-a/evidence-pack-x/task-1/a.json", "private/owner-a/ws-a/../ws-b/evidence/task-1/a"]) {
      await expect(a.put(key, bytes("x"), META), key).rejects.toThrow();
      await expect(a.delete(key), key).rejects.toThrow();
      expect(await a.stat(key), key).toBeUndefined();
    }
    expect(w.objects.size).toBe(0);
    expect(w.calls).toEqual([]);
  });

  it("reads nothing of another company's: not its pack, not its tails, whatever the key says", async () => {
    const w = world(); await w.workspace(A, "ws-a", "owner-a"); await w.workspace(B, "ws-b", "owner-b");
    await w.blobsOf(B).put("private/owner-b/ws-b/evidence-pack/task-9/" + "c".repeat(64) + ".json", bytes("b's pack"), META, { overwrite: true });
    const a = w.blobsOf(A);
    expect(await a.get("private/owner-b/ws-b/evidence-pack/task-9/" + "c".repeat(64) + ".json", 1_000)).toBeUndefined();
    expect(await a.stat("private/owner-b/ws-b/evidence-pack/task-9/" + "c".repeat(64) + ".json")).toBeUndefined();
    expect(text(await w.blobsOf(B).get("private/owner-b/ws-b/evidence-pack/task-9/" + "c".repeat(64) + ".json", 1_000))).toBe("b's pack");
    // a key naming the owner of the company's own workspace but another workspace id
    expect(await a.get("private/owner-a/ws-b/evidence-pack/task-9/" + "c".repeat(64) + ".json", 1_000)).toBeUndefined();
    expect(w.calls.filter((call) => call.startsWith("get") && call.includes("owner-b")).length).toBe(1);
  });

  it("reads a worker's saved artifact only through this company's own ARTIFACT row (the raw evidence file)", async () => {
    const w = world(); await w.workspace(A, "ws-a", "owner-a"); await w.workspace(B, "ws-a", "owner-b");
    const key = artifactObjectKey("ws-a", "op-1", "evidence-raw.json");
    w.objects.set(key, bytes("raw"));
    expect(await w.blobsOf(A).get(key, 100)).toBeUndefined();
    await w.store.put({ item: { ...workspaceKey(A, "ws-a"), sk: "ARTIFACT#op-1#evidence-raw.json", entityType: "ARTIFACT", objectKey: key } });
    expect(text(await w.blobsOf(A).get(key, 100))).toBe("raw");
    // B holds a workspace of the same raw id but never recorded the artifact
    expect(await w.blobsOf(B).get(key, 100)).toBeUndefined();
  });

  it("reads up to the evidence readers' room (the raw file's 2 MiB and the pack's 4 MiB), never more, and never more than asked", async () => {
    const w = world(); await w.workspace(A, "ws-a", "owner-a");
    const big = "private/owner-a/ws-a/evidence-pack/task-1/" + "c".repeat(64) + ".json";
    w.objects.set(big, new Uint8Array(2 * 1_048_576 + 5));
    const a = w.blobsOf(A);
    expect((await a.get(big, 4 * 1_048_576))?.byteLength).toBe(2 * 1_048_576 + 5);
    expect(await a.get(big, 1_000)).toBeUndefined();
    w.objects.set(big, new Uint8Array(COMPANY_EVIDENCE_READ_MAX_BYTES + 1));
    expect(await a.get(big, 100 * 1_048_576)).toBeUndefined();
    expect(await a.get(big, 0)).toBeUndefined();
    expect(await a.get(big, Number.NaN)).toBeUndefined();
  });

  it("reads no other owner-keyed document (a plan, a design) of the company, and a bad read cap leaves the flow reader's own", async () => {
    const w = world(); await w.workspace(A, "ws-a", "owner-a");
    w.objects.set("private/owner-a/ws-a/plan-documents/art-1.json", bytes("plan"));
    expect(await w.blobsOf(A).get("private/owner-a/ws-a/plan-documents/art-1.json", 100)).toBeUndefined();
    expect(w.calls).toEqual([]);
    // The flow's own artifacts reader (no maxReadBytes) keeps its 1.5 MiB room; a cap that is not a whole positive number is no cap.
    const big = new Uint8Array(COMPANY_ARTIFACT_READ_MAX_BYTES + 1);
    w.objects.set("private/owner-a/ws-a/plan-documents/big.json", big);
    for (const maxReadBytes of [undefined, Number.NaN, 0, -5, 1.5, Number.POSITIVE_INFINITY]) {
      const reader = createCompanyArtifactReader({ blobs: w.raw, store: w.store, companyId: A, ...(maxReadBytes === undefined ? {} : { maxReadBytes }) });
      expect(await reader.get("private/owner-a/ws-a/plan-documents/big.json", 10 * 1_048_576), String(maxReadBytes)).toBeUndefined();
    }
  });

  it("offers no prefix delete (the erase walks use their own handle)", async () => {
    const w = world(); await w.workspace(A, "ws-a", "owner-a");
    await expect(w.blobsOf(A).deletePrefix("private/owner-a/ws-a/evidence/")).rejects.toThrow(EVIDENCE_STORE_REFUSAL);
    expect(w.calls).toEqual([]);
  });

  it("fails closed when the company's store cannot answer: a read is not there, a write is refused, and the raw bucket is never touched", async () => {
    const w = world(); await w.workspace(A, "ws-a", "owner-a");
    const a = w.blobsOf(A);
    await a.put(PACK, bytes("x"), META, { overwrite: true });
    w.calls.length = 0; w.state.down = true;
    expect(await a.get(PACK, 100)).toBeUndefined();
    expect(await a.stat(PACK)).toBeUndefined();
    await expect(a.put(PACK, bytes("y"), META, { overwrite: true })).rejects.toThrow(EVIDENCE_STORE_REFUSAL);
    await expect(a.delete(PACK)).rejects.toThrow(EVIDENCE_STORE_REFUSAL);
    expect(w.calls).toEqual([]);
    expect(w.refusals).toEqual(["storage_unavailable", "storage_unavailable", "storage_unavailable", "storage_unavailable"]);
  });

  it("says why only in fixed words: no key, company or workspace id in an error or a log", async () => {
    const w = world(); await w.workspace(A, "ws-a", "owner-a");
    const seen: string[] = [];
    await w.blobsOf(A).put("private/owner-zzz-secret/ws-zzz-secret/evidence-pack/task-1/" + "c".repeat(64) + ".json", bytes("x"), META).catch((error: Error) => seen.push(error.message));
    expect(seen).toEqual([EVIDENCE_STORE_REFUSAL]);
    expect(JSON.stringify([seen, w.refusals])).not.toMatch(/zzz|org_/u);
  });
});
