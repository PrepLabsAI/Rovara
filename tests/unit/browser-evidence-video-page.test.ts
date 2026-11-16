// TE-H1 slice 4: the task page lists a failed page's video as a DOWNLOAD behind the page session (never inline, never a player on the page), says what a video is and is not, and the route that serves it takes only a WebM the task's
// current pack names, for a task of the install's own company, as an attachment no script can run from. A task with no video has the page it had.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalPagesServer, type LocalPagesServer } from "../../packages/broker/src/core/local-pages/index.js";
import type { LocalPageData } from "../../packages/broker/src/core/local-pages/views.js";
import { createLocalPageData } from "../../packages/broker/src/local/app/page-data.js";
import { createLocalEvidence } from "../../packages/broker/src/local/app/evidence.js";
import { createDocumentEvidenceBlobStore } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { keepEvidence } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { OTHER_TASK, TASK, fakeWorld, raw, type FakeWorld } from "../support/local-pages-fakes.js";
import { scanTextForTests } from "../support/evidence-scan.js";
import type { BrowserEvidenceCaptured } from "../../packages/contracts/src/index.js";

const A = "a".repeat(64);
const V = "d".repeat(64);
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x01]);
let server: LocalPagesServer;
let world: FakeWorld;
let base: string;
let asked: string[];

const panel = { runBy: "Run by Rovara in its sandbox", notProof: "Visual evidence only: it does not count as change proof.", pairs: [], videos: [{ route: "/checkout", sha256: V }], notes: ["/orders: Video not kept: over the size cap"] };

beforeEach(async () => {
  world = fakeWorld();
  asked = [];
  world.data.readEvidenceVideo = async (taskId, sha256) => { asked.push(`${taskId}/${sha256}`); return taskId === TASK && sha256 === V ? { contentType: "video/webm", bytes: WEBM } : undefined; };
  world.data.proof = { ...world.data.proof!, browserEvidence: panel };
  server = await createLocalPagesServer({ data: world.data, actions: world.actions });
  base = `/s/${server.sessions.mint().token}`;
});
afterEach(async () => { await server.close(); });
const host = () => new URL(server.origin).host;
const get = (path: string) => raw(server.origin, { path, headers: { host: host() } });

describe("the panel's videos", () => {
  it("lists each as a download link on the page's own route, says a video is not masked, and never plays one on the page", async () => {
    const page = await get(`${base}/proof/${TASK}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain(`href="${base}/proof/${TASK}/evidence-video/${V}"`);
    expect(page.body).toContain("download");
    expect(page.body).toContain("/orders: Video not kept: over the size cap");
    expect(page.body).toMatch(/not masked/u);
    expect(page.body).not.toMatch(/<video|<source|<script/iu);
  });

  it("a panel with no video has no video section and the page is what it was", async () => {
    world.data.proof = { ...world.data.proof!, browserEvidence: { ...panel, videos: undefined, notes: [] } as never };
    const page = await get(`${base}/proof/${TASK}`);
    expect(page.body).not.toContain("evidence-video");
    expect(page.body).not.toMatch(/not masked/u);
  });
});

describe("the video route", () => {
  it("serves a WebM the task names as an attachment that nothing can run from, behind the session", async () => {
    const reply = await get(`${base}/proof/${TASK}/evidence-video/${V}`);
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("video/webm");
    expect(String(reply.headers["content-disposition"])).toMatch(/^attachment/u);
    expect(String(reply.headers["content-security-policy"])).toContain("sandbox");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    expect(reply.headers["content-length"]).toBe(String(WEBM.byteLength));
  });

  it("answers a missing or wrong session, a digest that is not one, another task and a video nobody names exactly like a page that is not there", async () => {
    expect((await get(`${base}/proof/${TASK}/evidence-video/${"c".repeat(64)}`)).status).toBe(404);
    for (const path of [`/s/${"A".repeat(43)}/proof/${TASK}/evidence-video/${V}`, `/proof/${TASK}/evidence-video/${V}`]) expect((await get(path)).status, path).toBe(404);
    expect(asked.filter((entry) => entry.endsWith(`/${V}`))).toEqual([]);
    for (const tail of ["zz", "D".repeat(64), `${V}0`, V.slice(1), `${V}/x`, `../${V}`]) expect((await get(`${base}/proof/${TASK}/evidence-video/${tail}`)).status, tail).toBe(404);
    expect((await get(`${base}/proof/${OTHER_TASK}/evidence-video/${V}`)).status).toBe(404);
  });

  it("serves only a WebM within the cap (a picture's route never serves one, nor the reverse), and nothing when the install has no such reader", async () => {
    world.data.readEvidenceVideo = async () => ({ contentType: "text/html", bytes: new TextEncoder().encode("<script>alert(1)</script>") });
    expect((await get(`${base}/proof/${TASK}/evidence-video/${V}`)).status).toBe(404);
    world.data.readEvidenceVideo = async () => ({ contentType: "video/webm", bytes: new Uint8Array(2 * 1024 * 1024 + 1) });
    expect((await get(`${base}/proof/${TASK}/evidence-video/${V}`)).status).toBe(404);
    world.data.readEvidenceVideo = async () => ({ contentType: "video/webm", bytes: WEBM });
    world.data.readEvidenceImage = async () => ({ contentType: "video/webm", bytes: WEBM });
    expect((await get(`${base}/proof/${TASK}/evidence/${A}`)).status).toBe(404);
    delete (world.data as Partial<LocalPageData>).readEvidenceVideo;
    expect((await get(`${base}/proof/${TASK}/evidence-video/${V}`)).status).toBe(404);
  });
});

describe("the page data", () => {
  const COMPANY = "org_00000000000000000000";
  const OTHER = "org_11111111111111111111";
  const task = { ownerKey: "owner-1", workspaceId: "ws-1" };
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const jpeg = (seed: string) => { const bytes = new Uint8Array(500); bytes.set([0xff, 0xd8, 0xff]); bytes.fill(seed.charCodeAt(0), 3); return bytes; };
  const webm = (seed: string) => { const bytes = new Uint8Array(900); bytes.set([0x1a, 0x45, 0xdf, 0xa3]); bytes.fill(seed.charCodeAt(0), 4); return bytes; };
  const run = (): BrowserEvidenceCaptured => ({ isolation: "sandbox", durationMs: 1, notShown: [], moreNotShown: 0, routes: [
    { route: "/checkout", status: "shown", before: { bytes: jpeg("a"), sha256: sha(jpeg("a")) }, after: { bytes: jpeg("b"), sha256: sha(jpeg("b")) }, consoleErrors: { before: 0, after: 1 }, video: { bytes: webm("v"), sha256: sha(webm("v")) } }] });

  async function pages(companyOfTask: string) {
    const documents = new MemoryDocumentStore();
    const blobs = createDocumentEvidenceBlobStore(documents, { companyId: COMPANY });
    const taskId = "0b4f2b1e-3c6a-4d2e-9a77-5f1d8c0a1e11";
    const digest = "c".repeat(64);
    await keepEvidence({ scan: scanTextForTests, actions: { async artifacts() { return []; }, async readArtifact() { return ""; } }, store: { blobs } },
      { orgId: "org-a", task: { ...task, taskId }, operationId: "op-1", candidateDigest: digest, checks: [], browserEvidence: run() });
    await documents.put({ item: { ...taskKey(taskId), entityType: "TASK", taskId, companyId: companyOfTask, ownerKey: task.ownerKey, workspaceId: task.workspaceId, title: "T", workflow: { revision: 1, candidate: { digest } } } });
    const evidence = createLocalEvidence({ flow: { store: documents, companyId: COMPANY }, blobs: blobs });
    const data = createLocalPageData({ flow: { store: documents } as never, blobs: blobs, owner: {} as never, companyId: COMPANY, evidence });
    return { data, taskId };
  }

  it("reads a video of the task's own company as a WebM, not a picture's digest, not another task's, and not one of a task that belongs to another company", async () => {
    const own = await pages(COMPANY);
    expect(await own.data.readEvidenceVideo?.(own.taskId, sha(webm("v")))).toMatchObject({ contentType: "video/webm" });
    expect(await own.data.readEvidenceVideo?.(own.taskId, sha(jpeg("a")))).toBeUndefined();
    expect(await own.data.readEvidenceVideo?.(own.taskId, sha(webm("z")))).toBeUndefined();
    expect(await own.data.readEvidenceVideo?.("0b4f2b1e-3c6a-4d2e-9a77-5f1d8c0a1e12", sha(webm("v")))).toBeUndefined();
    // And the picture reader never hands out a video.
    expect(await own.data.readEvidenceImage?.(own.taskId, sha(webm("v")))).toBeUndefined();
    const other = await pages(OTHER);
    expect(await other.data.readEvidenceVideo?.(other.taskId, sha(webm("v")))).toBeUndefined();
  });
});
