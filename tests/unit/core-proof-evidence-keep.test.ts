// Proof and evidence (wire-proof), the broker's half: the evidence of a verification run is assembled and kept once. The worker's raw file is untrusted; the data guard drops
// every part that holds personal data, a credential or production data BEFORE anything is stored, shown or posted; a pack is read back only for the exact code it was kept for.
// (Port lane L7b: the store is the evidence blob store over the document store, not a bucket; the data guard's scan is passed in; Cloud's wiring switch is the task flow's.)
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type CheckEntry, type TestEnvProdDeny } from "../../packages/contracts/src/index.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentEvidenceBlobStore, type EvidenceBlobStore } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { dataGuardScanWorks, evidenceFindings as findings, guardPack as guard, guardRaw as guardRawWith, evidenceTexts } from "../../packages/broker/src/core/proof/evidence-guard.js";
import { evidencePackKey, keepEvidence, loadEvidencePack, policyKindsOf, type KeepEvidenceDeps } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { scanTextForTests } from "../support/evidence-scan.js";

const scan = scanTextForTests;
const evidenceFindings = (value: unknown, deny: TestEnvProdDeny) => findings(value, deny, scan);
const guardPack = (pack: Parameters<typeof guard>[0], artifacts: Parameters<typeof guard>[1], deny: TestEnvProdDeny) => guard(pack, artifacts, deny, scan);
const guardRaw = (raw: Parameters<typeof guardRawWith>[0], deny: TestEnvProdDeny) => guardRawWith(raw, deny, scan);

const DIGEST = "c".repeat(64);
const OTHER = "e".repeat(64);
const TASK = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "task-1" };
const OP = "op-1";
const PREFIX = `private/${TASK.ownerKey}/${TASK.workspaceId}/${OP}/`;
const entry = (id: string, label: string, over: Partial<CheckEntry> = {}): CheckEntry => ({ id, label, source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 700, exitCode: 0, ...over });
const names = (...list: string[]) => list.map((name) => ({ name, status: "passed" as const }));
const tests = (list: string[], over: Record<string, unknown> = {}) => ({ total: list.length, passed: list.length, failed: 0, skipped: 0, errored: 0, names: names(...list), newTests: list.slice(0, 1), ...over });
const rawOf = (checks: unknown[], digest = DIGEST) => ({ schemaVersion: 1, candidateDigest: digest, checks, selection: { method: "full", selected: 3, total: 3 } });

/** The evidence blob store over an in-memory document store, and the artifact listing the broker reads the raw file through. */
function world(rawText: string | undefined, over: { key?: string } = {}) {
  const documents = new MemoryDocumentStore();
  const blobs = createDocumentEvidenceBlobStore(documents, { companyId: "org_00000000000000000000" });
  const sent: string[] = [];
  const counting: EvidenceBlobStore = { ...blobs, put: async (key, bytes, meta) => { sent.push(`put ${key}`); await blobs.put(key, bytes, meta); } };
  const objects = {
    keys: async (): Promise<string[]> => (await documents.query({ pk: "ORG#org_00000000000000000000#EVIDENCE_BLOB" })).items.map((item) => item.sk),
    text: async (key: string): Promise<string | undefined> => { const bytes = await blobs.get(key, 10_000_000); return bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8"); },
    all: async (): Promise<string> => (await Promise.all((await objects.keys()).map((key) => objects.text(key)))).join("\n"),
  };
  const reads: string[] = [];
  const marked: string[] = [];
  const raw = async (key: string, max: number): Promise<string> => { reads.push(key); return key.startsWith(PREFIX) && rawText !== undefined ? rawText.slice(0, max) : ""; };
  const actions: KeepEvidenceDeps["actions"] = {
    async artifacts() { return rawText === undefined ? [] : [{ name: "evidence-raw.json", objectKey: over.key ?? `${PREFIX}evidence-raw.json` }]; },
    async readArtifact(key, max) {
      const stored = await objects.text(key);
      return stored !== undefined ? stored.slice(0, max) : raw(key, max);
    },
  };
  const deps: KeepEvidenceDeps = { scan, markStored: async (orgId) => { marked.push(`${orgId}@${String(sent.length)}`); }, actions, store: { blobs: counting } };
  return { deps, objects, sent, reads, marked };
}
const input = (over: Record<string, unknown> = {}) => ({ orgId: "org-a", task: TASK, operationId: OP, candidateDigest: DIGEST, checks: [entry("readiness:0", "pytest -q"), entry("readiness:1", "ruff check .")], ...over });

describe("assembling the evidence of a run", () => {

  it("is read back only for the exact code: another digest, and a key of another task, give nothing", async () => {
    const w = world(JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["t1", "t2", "t3"]) }])));
    await keepEvidence(w.deps, input());
    expect(await loadEvidencePack(w.deps.store.blobs, TASK, OTHER)).toBeUndefined();
    expect(await loadEvidencePack(w.deps.store.blobs, { ...TASK, taskId: "task-2" }, DIGEST)).toBeUndefined();
    expect(await loadEvidencePack(w.deps.store.blobs, TASK, undefined)).toBeUndefined();
    // A pack kept for other code, found under this code's key, is not this code's.
    await w.deps.store.blobs.put(evidencePackKey(TASK, OTHER), Buffer.from((await w.objects.text(evidencePackKey(TASK, DIGEST)))!, "utf8"), { contentType: "application/json", metadata: {}, retention: "evidence-std" });
    expect(await loadEvidencePack(w.deps.store.blobs, TASK, OTHER)).toBeUndefined();
    expect(await loadEvidencePack(w.deps.store.blobs, TASK, "../../etc")).toBeUndefined();
    expect(evidencePackKey(TASK, DIGEST)).toBe(`private/owner-1/ws-1/evidence-pack/task-1/${DIGEST}.json`);
  });

  it("keeps nothing for a raw file of other code; for none at all or one outside the operation's own prefix it keeps a pack that says not captured; an unreadable one is the broker's verdicts and says so", async () => {
    const good = JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["t1", "t2", "t3"]) }]));
    expect(await keepEvidence(world(JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["t1", "t2", "t3"]) }], OTHER))).deps, input())).toEqual({ kept: false, reason: "not_bound" });
    // No raw file (an older worker was sent no request): recorded as NOT CAPTURED in the log and on the pack, which holds only the broker's own verdicts; the page can tell it from expired or off.
    const logged: string[] = [];
    const none = world(undefined);
    expect(await keepEvidence({ ...none.deps, log: (event) => { logged.push(event); } }, input())).toMatchObject({ kept: true });
    expect(logged).toEqual(["evidence.not_captured"]);
    const notCaptured = await loadEvidencePack(none.deps.store.blobs, TASK, DIGEST);
    expect(notCaptured?.notTested).toContainEqual({ kind: "environment", id: "evidence_capture", text: "Test details were not captured for this run", reason: "the worker reported none" });
    expect(notCaptured?.checks.every((check) => check.tests === undefined && check.outputTailRef === undefined)).toBe(true);
    expect(notCaptured?.checks.map((check) => check.after)).toEqual(["passed", "passed"]);
    // A raw file outside the operation's own prefix is not read: the same, not captured.
    const outside = world(good, { key: `private/another-owner/${TASK.workspaceId}/${OP}/evidence-raw.json` });
    expect(await keepEvidence(outside.deps, input())).toMatchObject({ kept: true });
    expect((await loadEvidencePack(outside.deps.store.blobs, TASK, DIGEST))?.notTested.some((item) => item.id === "evidence_capture")).toBe(true);
    // A pack made from a raw file does not say so.
    const captured = world(good);
    await keepEvidence(captured.deps, input());
    expect((await loadEvidencePack(captured.deps.store.blobs, TASK, DIGEST))?.notTested.some((item) => item.id === "evidence_capture")).toBe(false);
    // Unreadable: the pack still holds what the broker knows itself, and says the details could not be read.
    const unreadable = world("{ not json");
    expect(await keepEvidence(unreadable.deps, input())).toMatchObject({ kept: true });
    const pack = await loadEvidencePack(unreadable.deps.store.blobs, TASK, DIGEST);
    expect(pack?.checks.every((check) => check.tests === undefined)).toBe(true);
    expect(pack?.notTested.some((item) => item.reason === "could not be read")).toBe(true);
  });

  it("marks the org before the first object is stored, and stores nothing when the mark fails", async () => {
    const w = world(JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["t1", "t2", "t3"]) }])));
    expect(await keepEvidence(w.deps, input())).toMatchObject({ kept: true });
    // Marked when no object had been put yet.
    expect(w.marked[0]).toBe("org-a@0");
    const failing = world(JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["t1", "t2", "t3"]) }])));
    expect(await keepEvidence({ ...failing.deps, markStored: async () => { throw new Error("down"); } }, input())).toEqual({ kept: false, reason: "fault" });
    expect(failing.sent).toEqual([]);
  });

  it("takes the approved policy's kind for a check, and treats a check with a test report as a test check", () => {
    expect([...policyKindsOf([{ kind: "lint" }, {}, { kind: "security" }])]).toEqual([["readiness:0", "lint"], ["readiness:2", "security"]]);
  });
});

describe("a scan that is not the data guard", () => {
  it("is told by canaries: the real kind of scan works, and a stub that finds nothing, finds everything nowhere, or throws does not", () => {
    expect(dataGuardScanWorks(scan)).toBe(true);
    expect(dataGuardScanWorks(() => [])).toBe(false);
    expect(dataGuardScanWorks((text) => (text.includes("4111") ? ["card_number"] : []))).toBe(false);
    expect(dataGuardScanWorks(() => { throw new Error("down"); })).toBe(false);
  });

  it("keeps nothing with such a scan, and stores nothing", async () => {
    const w = world(JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["t1", "t2", "t3"]) }])));
    expect(await keepEvidence({ ...w.deps, scan: () => [] }, input())).toEqual({ kept: false, reason: "withheld" });
    expect(w.sent).toEqual([]);
    expect(w.marked).toEqual([]);
  });
});

describe("the data guard on the evidence", () => {
  const EMAIL = "jane.doe@gmail.com";
  const CARD = "4111 1111 1111 1111";

  it("drops a part that names a host on the company's production deny list", async () => {
    const deny: TestEnvProdDeny = { accountIds: [], hosts: ["*.prod.example.com"], arnPrefixes: [] };
    const w = world(JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["test_calls_api.prod.example.com", "t2", "t3"]) }])));
    const result = await keepEvidence(w.deps, input({ deny }));
    expect(result).toMatchObject({ kept: true, guardedParts: 1 });
    expect((await loadEvidencePack(w.deps.store.blobs, TASK, DIGEST))?.checks[0]?.tests).toBeUndefined();
    // The same names pass when no list names the host.
    const clean = world(JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["test_calls_api.prod.example.com", "t2", "t3"]) }])));
    await keepEvidence(clean.deps, input());
    expect((await loadEvidencePack(clean.deps.store.blobs, TASK, DIGEST))?.checks[0]?.tests?.total).toBe(3);
  });

  it("a digest or a timestamp is not scanned: 64 hex characters with a long digit run are not a card", () => {
    const digest = `${"1".repeat(10)}${"a".repeat(54)}`;
    expect(evidenceTexts({ sha: digest, at: "2026-11-02T00:00:00.000Z", name: "x" })).toEqual(["x"]);
    expect(evidenceFindings({ sha: "4111111111111111".padEnd(64, "a") }, { accountIds: [], hosts: [], arnPrefixes: [] })).toEqual([]);
  });

  it("the built pack is checked again: a check label that holds an email (a command the repository wrote) becomes a numbered label, and nothing is stored with it", async () => {
    const w = world(JSON.stringify(rawOf([{ checkId: "readiness:0", tests: tests(["t1", "t2", "t3"]) }])));
    const result = await keepEvidence(w.deps, input({ checks: [entry("readiness:0", `curl https://api.example.com --user ${EMAIL}`), entry("readiness:1", "ruff check .")] }));
    expect(result).toMatchObject({ kept: true, guardedParts: 1 });
    const pack = await loadEvidencePack(w.deps.store.blobs, TASK, DIGEST);
    expect(pack?.checks[0]?.label).toBe("Check 1");
    expect(pack?.checks[1]?.label).toBe("ruff check .");
    expect(await w.objects.all()).not.toContain(EMAIL);
  });

  it("guardPack drops an output tail that holds a finding, with the stored text, and keeps the broker's verdict", () => {
    const text = `charged ${CARD} ok`;
    const ref = { kind: "log_txt" as const, sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text), retentionClass: "evidence-std" as const };
    const pack = { schemaVersion: 1, candidateDigest: DIGEST, environment: { tier: "sandbox", envRevision: 0, services: [], data: "synthetic", accounts: [] }, checks: [{ checkId: "a", kind: "other", label: "x", before: "passed", after: "failed", class: "passing", durationMs: 1, outputTailRef: ref }], selection: { method: "full", selected: 0, total: 0 }, api: [], browser: [], notTested: [] } as never;
    const guarded = guardPack(pack, [{ ref, text }], { accountIds: [], hosts: [], arnPrefixes: [] });
    expect(guarded.newArtifacts).toEqual([]);
    expect(guarded.pack?.checks[0]).not.toHaveProperty("outputTailRef");
    expect(guarded.pack?.checks[0]).toMatchObject({ checkId: "a", after: "failed" });
    expect(guarded.dropped.kinds).toContain("card_number");
  });

  it("fails closed on a text it cannot scan", () => {
    expect(evidenceFindings({ name: "x".repeat(5 * 1024 * 1024) }, { accountIds: [], hosts: [], arnPrefixes: [] })).toEqual(["secret"]);
  });

  it("guardRaw and guardPack work on values: a flagged label becomes a numbered one, a flagged environment withholds the pack", () => {
    const raw = guardRaw({ schemaVersion: 1, candidateDigest: DIGEST, checks: [{ checkId: "a", tests: tests([`x ${EMAIL}`]) }, { checkId: "b" }] } as never, { accountIds: [], hosts: [], arnPrefixes: [] });
    expect(raw.raw.checks.map((check) => check.checkId)).toEqual(["b"]);
    expect(raw.dropped.parts).toBe(1);
    expect(raw.dropped.kinds).toEqual(["email"]);
    const pack = { schemaVersion: 1, candidateDigest: DIGEST, environment: { tier: "sandbox", envRevision: 0, services: [], data: "synthetic", accounts: [] }, checks: [{ checkId: "a", kind: "other", label: `run ${EMAIL}`, before: "passed", after: "passed", class: "passing", durationMs: 1 }], selection: { method: "full", selected: 0, total: 0 }, api: [], browser: [], notTested: [] } as never;
    expect(guardPack(pack, [], { accountIds: [], hosts: [], arnPrefixes: [] }).pack?.checks[0]?.label).toBe("Check 1");
    const bad = { ...(pack as object), notTested: [{ kind: "environment", id: "x", text: `see ${EMAIL}`, reason: "r" }] } as never;
    expect(guardPack(bad, [], { accountIds: [], hosts: [], arnPrefixes: [] }).pack).toBeUndefined();
  });
});

