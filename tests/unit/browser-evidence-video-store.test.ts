// TE-H1 slice 4: the video of a failed page goes into the evidence store under the same rules as every artifact: the task's key in the company's partition, kind `webm` (short retention), magic bytes checked, read back only
// through `readEvidenceArtifact` when the task's CURRENT pack names it (a download, never inline), and never left behind by a keep that writes no pack. A video the store cannot hold is "not stored", never a reference to nothing.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BROWSER_EVIDENCE_VIDEO_NOT_KEPT_WORDS, EVIDENCE_RETENTION_DAYS, INDEX_EXPIRY_ATTRIBUTE, companyScoped, browserEvidenceLines, browserEvidenceOutcomeOfPack, browserEvidencePanelOf,
  type BrowserEvidenceCaptured, type CheckEntry, type EvidencePackV2,
} from "../../packages/contracts/src/index.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentEvidenceBlobStore, type EvidenceBlobStore } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { evidenceArtifactKey, readEvidenceArtifact } from "../../packages/broker/src/core/proof/evidence-artifacts.js";
import { storeBrowserEvidence } from "../../packages/broker/src/core/proof/browser-evidence-store.js";
import { evidencePackKey, keepEvidence, loadEvidenceRead, type KeepEvidenceDeps } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { createLocalEvidence } from "../../packages/broker/src/local/app/evidence.js";
import { scanTextForTests } from "../support/evidence-scan.js";

const DIGEST = "c".repeat(64);
const TASK = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "task-1" };
const COMPANY_A = "org_00000000000000000000";
const COMPANY_B = "org_11111111111111111111";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const jpeg = (seed: string) => { const bytes = new Uint8Array(500); bytes.set([0xff, 0xd8, 0xff]); bytes.fill(seed.charCodeAt(0), 3); return bytes; };
const webm = (seed: string, size = 2_000) => { const bytes = new Uint8Array(size); bytes.set([0x1a, 0x45, 0xdf, 0xa3]); bytes.fill(seed.charCodeAt(0), 4); return bytes; };
const shot = (seed: string) => ({ bytes: jpeg(seed), sha256: sha(jpeg(seed)) });
const clip = (seed: string, size = 2_000) => ({ bytes: webm(seed, size), sha256: sha(webm(seed, size)) });
const captured = (): BrowserEvidenceCaptured => ({
  isolation: "sandbox", durationMs: 3_000, notShown: [], moreNotShown: 0,
  routes: [{ route: "/checkout", status: "shown", before: shot("a"), after: shot("b"), consoleErrors: { before: 0, after: 2 }, video: clip("v") }, { route: "/settings", status: "not_run", reason: "page_did_not_load", video: clip("w") }],
});
const entry = (id: string, label: string): CheckEntry => ({ id, label, source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 700, exitCode: 0 });
const input = (over: Record<string, unknown> = {}) => ({ orgId: "org-a", task: TASK, operationId: "op-1", candidateDigest: DIGEST, checks: [entry("readiness:0", "pytest -q")], ...over });

function world(company = COMPANY_A, documents = new MemoryDocumentStore()) {
  const blobs = createDocumentEvidenceBlobStore(documents, { companyId: company });
  const actions: KeepEvidenceDeps["actions"] = { async artifacts() { return []; }, async readArtifact() { return ""; } };
  return { documents, blobs, deps: { scan: scanTextForTests, actions, store: { blobs } } satisfies KeepEvidenceDeps };
}
const storedPack = async (blobs: ReturnType<typeof world>["blobs"]) => JSON.parse(Buffer.from((await blobs.get(evidencePackKey(TASK, DIGEST), 4_194_304))!).toString("utf8")) as EvidencePackV2;
const heldKey = (sha256: string) => evidenceArtifactKey(TASK.ownerKey, TASK.workspaceId, TASK.taskId, sha256);
const read = async (w: ReturnType<typeof world>, sha256: string, over: { candidateDigest?: string | undefined; omitPack?: boolean; taskId?: string } = {}) => {
  const v2 = await loadEvidenceRead(w.blobs, TASK, DIGEST);
  return readEvidenceArtifact({ store: { blobs: w.blobs }, authorize: async () => ({ ...TASK, taskId: over.taskId ?? TASK.taskId, candidateDigest: "candidateDigest" in over ? over.candidateDigest : DIGEST, view: undefined, ...(v2?.status === "v2" && over.omitPack !== true ? { v2Pack: v2.pack } : {}) }) }, sha256);
};

describe("storing a failed page's video", () => {
  it("stores it as a webm under the task in the company's partition with the short retention, and names it on its page", async () => {
    const documents = new MemoryDocumentStore();
    const blobs = createDocumentEvidenceBlobStore(documents, { companyId: COMPANY_A, now: () => 1_000_000_000_000 });
    const outcome = await storeBrowserEvidence({ blobs }, TASK, captured());
    expect(outcome.routes[0]).toMatchObject({ route: "/checkout", status: "shown", video: { kind: "webm", sha256: clip("v").sha256, bytes: 2_000, retentionClass: "evidence-short" } });
    expect(outcome.routes[1]).toMatchObject({ route: "/settings", status: "not_run", reason: "page_did_not_load", video: { kind: "webm", sha256: clip("w").sha256 } });
    expect(Buffer.from((await blobs.get(heldKey(clip("v").sha256), 10_000))!)).toEqual(Buffer.from(webm("v")));
    // The standard retention for its class: 14 days by default (the row expires then), where the pictures keep 30.
    const ttlOf = async (sha256: string) => (await documents.get({ pk: companyScoped(COMPANY_A, "EVIDENCE_BLOB"), sk: heldKey(sha256) }))?.[documents.ttlAttribute ?? INDEX_EXPIRY_ATTRIBUTE];
    expect(await ttlOf(clip("v").sha256)).toBe(1_000_000_000 + EVIDENCE_RETENTION_DAYS["evidence-short"].default * 86_400);
    expect(await ttlOf(shot("a").sha256)).toBe(1_000_000_000 + EVIDENCE_RETENTION_DAYS["evidence-std"].default * 86_400);
    // Another company reading the very same key in the same table gets nothing: the scope is in the partition.
    const other = createDocumentEvidenceBlobStore(documents, { companyId: COMPANY_B });
    expect(await other.get(heldKey(clip("v").sha256), 10_000)).toBeUndefined();
  });

  it("a video the store does not keep is 'not stored' (the page's own result untouched), and a digest that does not match its bytes is not stored either", async () => {
    const w = world();
    const failing: EvidenceBlobStore = { ...w.blobs, async put(key, bytes, meta, options) { if (meta.metadata["kind"] === "webm") throw new Error("disk full at /var/secret"); return w.blobs.put(key, bytes, meta, options); } };
    const outcome = await storeBrowserEvidence({ blobs: failing }, TASK, captured());
    expect(outcome.routes[0]).toMatchObject({ status: "shown", videoNotKept: "not_stored" });
    expect(Object.keys(outcome.routes[0] ?? {})).not.toContain("video");
    expect(outcome.routes[1]).toEqual({ route: "/settings", status: "not_run", reason: "page_did_not_load", videoNotKept: "not_stored" });
    expect(JSON.stringify(outcome)).not.toContain("secret");
    const lying = captured();
    const second = lying.routes[1]!;
    if (second.video !== undefined) second.video = { ...second.video, sha256: "f".repeat(64) };
    expect((await storeBrowserEvidence({ blobs: w.blobs }, TASK, lying)).routes[1]).toMatchObject({ videoNotKept: "not_stored" });
  });

  it("a store that holds only what fits a document cannot hold a large video: 'not stored', never a reference to nothing", async () => {
    const w = world();
    const big = captured();
    big.routes = [{ route: "/settings", status: "not_run", reason: "page_did_not_load", video: clip("w", 1_500_000) }];
    const outcome = await storeBrowserEvidence({ blobs: w.blobs }, TASK, big);
    expect(outcome.routes[0]).toEqual({ route: "/settings", status: "not_run", reason: "page_did_not_load", videoNotKept: "not_stored" });
  });

  it("a video of a healthy page is refused with the whole run (the producer's rule, held again where it is stored)", async () => {
    const w = world();
    const bad = captured();
    bad.routes = [{ route: "/checkout", status: "shown", before: shot("a"), after: shot("b"), consoleErrors: { before: 0, after: 0 }, video: clip("v") }];
    await expect(storeBrowserEvidence({ blobs: w.blobs }, TASK, bad)).rejects.toThrow();
    expect(await w.blobs.get(heldKey(shot("a").sha256), 1_000)).toBeUndefined();
    expect(await w.blobs.get(heldKey(clip("v").sha256), 10_000)).toBeUndefined();
  });
});

describe("keeping a video in the pack", () => {
  it("writes a v2 pack with the video check; the result is still the checks' own; the lines and the panel say a video is kept and never where it is", async () => {
    const w = world();
    expect(await keepEvidence(w.deps, input({ browserEvidence: captured() }))).toMatchObject({ kept: true });
    const pack = await storedPack(w.blobs);
    expect(pack.checks.map((check) => check.id)).toEqual(["readiness:0", "browser_evidence", "browser_evidence_video"]);
    expect(pack.checks.find((check) => check.id === "browser_evidence_video")).toMatchObject({ kind: "visual", runBy: "rovara", stage: "sandbox", class: "not_rerun" });
    expect(pack.result).toBe("verified");
    const read2 = await loadEvidenceRead(w.blobs, TASK, DIGEST);
    const outcome = browserEvidenceOutcomeOfPack(read2?.status === "v2" ? read2.pack : undefined, DIGEST);
    const lines = browserEvidenceLines(outcome, {});
    expect(lines.find((line) => line.includes("/settings"))).toContain("Video of the failure: kept (download behind sign-in)");
    expect(JSON.stringify(lines)).not.toContain(clip("w").sha256);
    expect(browserEvidencePanelOf(outcome)?.videos?.map((row) => row.route)).toEqual(["/checkout", "/settings"]);
  });

  it("a video the store could not keep is a 'Not kept' row in the pack, and the pictures are still there", async () => {
    const w = world();
    const failing: EvidenceBlobStore = { ...w.blobs, async put(key, bytes, meta, options) { if (meta.metadata["kind"] === "webm") throw new Error("no"); return w.blobs.put(key, bytes, meta, options); } };
    await keepEvidence({ ...w.deps, store: { blobs: failing } }, input({ browserEvidence: captured() }));
    const pack = await storedPack(w.blobs);
    expect(pack.checks.some((check) => check.id === "browser_evidence_video")).toBe(false);
    expect(pack.notTested.map((row) => `${row.what} | ${row.reason}`)).toContain(`Browser evidence video: /settings | Not kept: ${BROWSER_EVIDENCE_VIDEO_NOT_KEPT_WORDS.not_stored}`);
    expect(await w.blobs.get(heldKey(shot("a").sha256), 1_000)).toBeDefined();
  });

  it("a keep that writes no pack leaves no picture and no video behind; a re-keep that fails keeps what the earlier pack names", async () => {
    const w = world();
    let calls = 0;
    expect(await keepEvidence({ ...w.deps, late: () => { calls += 1; return calls >= 2; } }, input({ browserEvidence: captured() }))).toEqual({ kept: false, reason: "fault" });
    for (const sha256 of [shot("a").sha256, shot("b").sha256, clip("v").sha256, clip("w").sha256]) expect(await w.blobs.get(heldKey(sha256), 10_000), sha256).toBeUndefined();
    const again = world();
    expect(await keepEvidence(again.deps, input({ browserEvidence: captured() }))).toMatchObject({ kept: true });
    let more = 0;
    expect(await keepEvidence({ ...again.deps, late: () => { more += 1; return more >= 2; } }, input({ browserEvidence: captured() }))).toEqual({ kept: false, reason: "fault" });
    expect(await again.blobs.get(heldKey(clip("v").sha256), 10_000)).toBeDefined();
    expect(await again.blobs.get(heldKey(clip("w").sha256), 10_000)).toBeDefined();
  });

  it("a writer that names another place than the outcome keeps the pack without either check, and the videos go with the pictures", async () => {
    const w = world();
    const laptop = { version: 2 as const, producer: { edition: "code" as const, isolation: "developer_machine" as const } };
    await keepEvidence(w.deps, input({ browserEvidence: captured(), writer: laptop }));
    const pack = await storedPack(w.blobs);
    expect(pack.checks.some((check) => check.id.startsWith("browser_evidence"))).toBe(false);
    expect(await w.blobs.get(heldKey(clip("v").sha256), 10_000)).toBeUndefined();
  });
});

describe("serving a video", () => {
  it("serves it only as a download of the right type, only when the CURRENT pack's video check names it", async () => {
    const w = world();
    await keepEvidence(w.deps, input({ browserEvidence: captured() }));
    expect(await read(w, clip("v").sha256)).toMatchObject({ status: 200, kind: "webm", contentType: "video/webm", disposition: "attachment", retentionClass: "evidence-short" });
    expect(await read(w, sha(webm("zzz")))).toEqual({ status: 404 });
    expect(await read(w, clip("v").sha256, { candidateDigest: "d".repeat(64) })).toEqual({ status: 404 });
    expect(await read(w, clip("v").sha256, { candidateDigest: undefined })).toEqual({ status: 404 });
    expect(await read(w, clip("v").sha256, { omitPack: true })).toEqual({ status: 404 });
    expect(await read(w, clip("v").sha256, { taskId: "task-2" })).toEqual({ status: 404 });
  });

  it("is closed to another company: its store holds none of this company's videos and its read of the same pack finds nothing", async () => {
    const documents = new MemoryDocumentStore();
    const a = world(COMPANY_A, documents);
    const b = world(COMPANY_B, documents);
    await keepEvidence(a.deps, input({ browserEvidence: captured() }));
    // B's own store has no pack and no video for this task, and B asking for A's video digest gets nothing, with A's pack in hand or not.
    expect(await loadEvidenceRead(b.blobs, TASK, DIGEST)).toBeUndefined();
    expect(await b.blobs.get(heldKey(clip("v").sha256), 10_000)).toBeUndefined();
    expect(await read(b, clip("v").sha256)).toEqual({ status: 404 });
    expect(await createLocalEvidence({ flow: { store: documents, companyId: COMPANY_B }, blobs: b.blobs }).browserEvidenceImageOf(TASK, DIGEST, clip("v").sha256)).toEqual({ status: 404 });
    // Positive control: the company that owns it is served.
    expect(await createLocalEvidence({ flow: { store: documents, companyId: COMPANY_A }, blobs: a.blobs }).browserEvidenceImageOf(TASK, DIGEST, clip("v").sha256)).toMatchObject({ status: 200, kind: "webm" });
  });

  it("the local evidence reads give the panel's videos and the lines for exactly this code", async () => {
    const w = world();
    await keepEvidence(w.deps, input({ browserEvidence: captured() }));
    const evidence = createLocalEvidence({ flow: { store: w.documents, companyId: COMPANY_A }, blobs: w.blobs });
    expect((await evidence.browserEvidencePanelOf(TASK, DIGEST))?.videos).toEqual([{ route: "/checkout", sha256: clip("v").sha256 }, { route: "/settings", sha256: clip("w").sha256 }]);
    expect(await evidence.browserEvidencePanelOf(TASK, "d".repeat(64))).toBeUndefined();
  });
});
