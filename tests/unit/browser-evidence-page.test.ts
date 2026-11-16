// TE-H1 slice 2 (DEC 241): the task page's before and after panel and the route that serves the pictures. The pictures are served behind the page session like every other route, only for a picture the task's current pack names,
// only for a task of the install's own company, and only as an inline JPEG that no script can run from.
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
import { createHash } from "node:crypto";
import type { BrowserEvidenceCaptured } from "../../packages/contracts/src/index.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
let server: LocalPagesServer;
let world: FakeWorld;
let base: string;
let asked: string[];

const panel = { runBy: "Run by Rovara in its sandbox", notProof: "Visual evidence only: it does not count as change proof.", pairs: [{ route: "/checkout", before: A, after: B }], notes: ["/settings: Not run: the page did not load"] };

beforeEach(async () => {
  world = fakeWorld();
  asked = [];
  world.data.readEvidenceImage = async (taskId, sha256) => { asked.push(`${taskId}/${sha256}`); return taskId === TASK && (sha256 === A || sha256 === B) ? { contentType: "image/jpeg", bytes: JPEG } : undefined; };
  world.data.proof = { ...world.data.proof!, browserEvidence: panel };
  server = await createLocalPagesServer({ data: world.data, actions: world.actions });
  base = `/s/${server.sessions.mint().token}`;
});
afterEach(async () => { await server.close(); });

const host = () => new URL(server.origin).host;
const get = (path: string) => raw(server.origin, { path, headers: { host: host() } });

describe("the panel", () => {
  it("shows who ran it, that it is not proof, the before and after pictures of each page behind the page's own routes, and the fixed notes", async () => {
    const page = await get(`${base}/proof/${TASK}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain("Before and after screenshots");
    expect(page.body).toContain("Run by Rovara in its sandbox. Visual evidence only: it does not count as change proof.");
    expect(page.body).toContain(`<img src="${base}/proof/${TASK}/evidence/${A}"`);
    expect(page.body).toContain(`<img src="${base}/proof/${TASK}/evidence/${B}"`);
    expect(page.body).toContain("/settings: Not run: the page did not load");
    // The pictures come from the page's own origin only (img-src 'self'), and no script runs on the page.
    expect(String(page.headers["content-security-policy"])).toContain("img-src 'self'");
    expect(page.body).not.toMatch(/<script/i);
  });
  it("is absent for a task with no browser evidence: the page is what it was", async () => {
    const { browserEvidence: _gone, ...without } = world.data.proof!;
    void _gone;
    world.data.proof = without;
    const page = await get(`${base}/proof/${TASK}`);
    expect(page.body).not.toContain("Before and after screenshots");
    expect(page.body).not.toContain("/evidence/");
  });
  it("escapes what it shows", async () => {
    world.data.proof = { ...world.data.proof!, browserEvidence: { ...panel, notes: ["<img src=x onerror=alert(1)>"] } };
    const page = await get(`${base}/proof/${TASK}`);
    expect(page.body).not.toContain("<img src=x");
  });
});

describe("the picture route", () => {
  it("serves a picture the task names, inline, as a JPEG nothing can run script from, behind the session", async () => {
    const reply = await get(`${base}/proof/${TASK}/evidence/${A}`);
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("image/jpeg");
    expect(String(reply.headers["content-security-policy"])).toContain("sandbox");
    expect(reply.headers["content-disposition"]).toBe("inline");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    expect(reply.headers["content-length"]).toBe(String(JPEG.byteLength));
  });
  it("answers a missing or wrong session, a digest that is not one, another task, and a picture nobody names, exactly like a page that is not there", async () => {
    const missing = await get(`${base}/proof/${TASK}/evidence/${"c".repeat(64)}`);
    expect(missing.status).toBe(404);
    for (const path of [`/s/${"A".repeat(43)}/proof/${TASK}/evidence/${A}`, `/proof/${TASK}/evidence/${A}`]) expect((await get(path)).status, path).toBe(404);
    expect(asked.filter((entry) => entry.endsWith(`/${A}`))).toEqual([]);
    for (const tail of ["zz", "A".repeat(64), `${A}0`, A.slice(1), `${A}/x`, `../${A}`]) expect((await get(`${base}/proof/${TASK}/evidence/${tail}`)).status, tail).toBe(404);
    expect((await get(`${base}/proof/${OTHER_TASK}/evidence/${A}`)).status).toBe(404);
  });
  it("serves only JPEGs within the cap, and nothing at all when the install has no such reader", async () => {
    world.data.readEvidenceImage = async () => ({ contentType: "image/svg+xml", bytes: new TextEncoder().encode("<svg onload=alert(1)/>") });
    expect((await get(`${base}/proof/${TASK}/evidence/${A}`)).status).toBe(404);
    world.data.readEvidenceImage = async () => ({ contentType: "image/jpeg", bytes: new Uint8Array(9 * 1024 * 1024) });
    expect((await get(`${base}/proof/${TASK}/evidence/${A}`)).status).toBe(404);
    delete (world.data as Partial<LocalPageData>).readEvidenceImage;
    expect((await get(`${base}/proof/${TASK}/evidence/${A}`)).status).toBe(404);
  });
});

describe("the page data", () => {
  const COMPANY = "org_00000000000000000000";
  const OTHER = "org_11111111111111111111";
  const task = { ownerKey: "owner-1", workspaceId: "ws-1" };
  const jpeg = (seed: string) => { const bytes = new Uint8Array(500); bytes.set([0xff, 0xd8, 0xff]); bytes.fill(seed.charCodeAt(0), 3); return bytes; };
  const shot = (seed: string) => ({ bytes: jpeg(seed), sha256: createHash("sha256").update(jpeg(seed)).digest("hex") });
  const run = (): BrowserEvidenceCaptured => ({ isolation: "sandbox", durationMs: 1, notShown: [], moreNotShown: 0, routes: [{ route: "/checkout", status: "shown", before: shot("a"), after: shot("b"), consoleErrors: { before: 0, after: 0 } }] });

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
  it("reads a picture of the task's own company, and not one of a task that belongs to another company", async () => {
    const own = await pages(COMPANY);
    expect(await own.data.readEvidenceImage?.(own.taskId, shot("a").sha256)).toMatchObject({ contentType: "image/jpeg" });
    expect(await own.data.readEvidenceImage?.(own.taskId, shot("z").sha256)).toBeUndefined();
    expect(await own.data.readEvidenceImage?.("0b4f2b1e-3c6a-4d2e-9a77-5f1d8c0a1e12", shot("a").sha256)).toBeUndefined();
    const other = await pages(OTHER);
    expect(await other.data.readEvidenceImage?.(other.taskId, shot("a").sha256)).toBeUndefined();
  });
});
