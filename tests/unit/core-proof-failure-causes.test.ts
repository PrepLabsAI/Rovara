// TE-A6 Parts B and C (DEC 254zt), the broker's half: the worker's `failure-causes.json` is untrusted. It is read only from the operation's own prefix, bound to the candidate's digest and to the check's own failing
// tests, passed through the data guard like every other test name, and kept in the check's `tests` part. Anything else is no causes, and the pack is exactly what it always was.
import { describe, expect, it } from "vitest";
import { EvidencePackSchema, FAILURE_CAUSES_ARTIFACT, FAILURE_CAUSES_FILE_MAX_BYTES, type CheckEntry } from "../../packages/contracts/src/index.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentEvidenceBlobStore } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { keepEvidence, loadEvidencePack, type KeepEvidenceDeps } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { scanTextForTests } from "../support/evidence-scan.js";

const DIGEST = "c".repeat(64);
const OTHER = "e".repeat(64);
const SHA = "a".repeat(40);
const TASK = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "task-1" };
const OP = "op-1";
const PREFIX = `private/${TASK.ownerKey}/${TASK.workspaceId}/${OP}/`;
const FAILING = "tests/cart.test.ts::applies discount";
const entry = (over: Partial<CheckEntry> = {}): CheckEntry => ({ id: "readiness:0", label: "vitest", source: "project", before: "passed", after: "failed", class: "regression", output: "", durationMs: 700, exitCode: 1, ...over });
const raw = (digest = DIGEST) => JSON.stringify({
  schemaVersion: 1, candidateDigest: digest,
  checks: [{ checkId: "readiness:0", tests: { total: 2, passed: 1, failed: 1, skipped: 0, errored: 0, names: [{ name: FAILING, status: "failed" }, { name: "tests/cart.test.ts::keeps total", status: "passed" }], newTests: [] } }],
  selection: { method: "full", selected: 2, total: 2 },
});
const change = (path: string) => ({ kind: "change", paths: [path], pathsCount: 1, commit: SHA, basis: ["named_in_failure"] });
const causesFile = (over: Record<string, unknown> = {}, causes: unknown[] = [{ testId: FAILING, cause: change("src/cart.ts") }]) => JSON.stringify({ schemaVersion: 1, candidateDigest: DIGEST, checks: [{ checkId: "readiness:0", causes }], ...over });

function world(causes: string | undefined, over: { causesKey?: string } = {}) {
  const documents = new MemoryDocumentStore();
  const blobs = createDocumentEvidenceBlobStore(documents, { companyId: "org_00000000000000000000" });
  const stored = new Map<string, string>([[`${PREFIX}evidence-raw.json`, raw()], ...(causes === undefined ? [] : [[over.causesKey ?? `${PREFIX}${FAILURE_CAUSES_ARTIFACT}`, causes] as [string, string]])]);
  const actions: KeepEvidenceDeps["actions"] = {
    async artifacts() {
      return [{ name: "evidence-raw.json", objectKey: `${PREFIX}evidence-raw.json` }, ...(causes === undefined ? [] : [{ name: FAILURE_CAUSES_ARTIFACT, objectKey: over.causesKey ?? `${PREFIX}${FAILURE_CAUSES_ARTIFACT}` }])];
    },
    async readArtifact(key, max) { return (stored.get(key) ?? "").slice(0, max); },
  };
  const deps: KeepEvidenceDeps = { scan: scanTextForTests, actions, store: { blobs } };
  return { deps };
}
const input = () => ({ orgId: "org-a", task: TASK, operationId: OP, candidateDigest: DIGEST, checks: [entry()] });
const keep = async (causes: string | undefined, over: { causesKey?: string } = {}) => {
  const w = world(causes, over);
  const result = await keepEvidence(w.deps, input());
  return { result, pack: await loadEvidencePack(w.deps.store.blobs, TASK, DIGEST) };
};

describe("the failure causes a worker saved", () => {
  it("are kept in the failed check's tests part, the pack still valid", async () => {
    const { result, pack } = await keep(causesFile());
    expect(result).toMatchObject({ kept: true });
    expect(EvidencePackSchema.safeParse(pack).success).toBe(true);
    expect(pack?.checks[0]?.tests?.failureCauses).toEqual([{ testId: FAILING, cause: change("src/cart.ts") }]);
  });

  it("golden: with no file, or one that is ignored, the pack is byte-identical to the pack without them", async () => {
    const plain = JSON.stringify((await keep(undefined)).pack);
    expect(plain).not.toContain("failureCauses");
    for (const ignored of [
      causesFile({ candidateDigest: OTHER }), "not json", causesFile({ schemaVersion: 2 }), causesFile({ extra: 1 }),
      causesFile({}, [{ testId: FAILING, cause: { kind: "from_the_future" } }]), "x".repeat(FAILURE_CAUSES_FILE_MAX_BYTES + 5),
      // A cause for a test this check does not show failing: the merged raw file no longer fits its schema, so none is used.
      causesFile({}, [{ testId: "tests/cart.test.ts::keeps total", cause: change("src/cart.ts") }]), causesFile({}, [{ testId: "tests/other.test.ts::nope", cause: change("src/cart.ts") }]),
    ]) expect(JSON.stringify((await keep(ignored)).pack)).toBe(plain);
  });

  it("are read only from the operation's own prefix: another owner's file is never used (two companies)", async () => {
    const plain = JSON.stringify((await keep(undefined)).pack);
    const theirs = await keep(causesFile(), { causesKey: `private/another-owner/${TASK.workspaceId}/${OP}/${FAILURE_CAUSES_ARTIFACT}` });
    expect(JSON.stringify(theirs.pack)).toBe(plain);
    const otherWorkspace = await keep(causesFile(), { causesKey: `private/${TASK.ownerKey}/ws-other/${OP}/${FAILURE_CAUSES_ARTIFACT}` });
    expect(JSON.stringify(otherWorkspace.pack)).toBe(plain);
  });

  it("go through the data guard like every test name: a path with personal data takes the causes out alone, and the check's test names, verdict and the rest stay", async () => {
    const email = ["maya", "acme.com"].join("@");
    const { result, pack } = await keep(causesFile({}, [{ testId: FAILING, cause: change(`src/${email}.ts`) }]));
    expect(result).toMatchObject({ kept: true, guardedParts: 1 });
    expect(JSON.stringify(pack)).not.toContain(email);
    expect(pack?.checks[0]).toMatchObject({ checkId: "readiness:0", after: "failed" });
    expect(pack?.checks[0]?.tests?.names.map((name) => name.name)).toContain(FAILING);
    expect(pack?.checks[0]?.tests?.failureCauses).toBeUndefined();
  });

  it("says in the log, with a fixed word and nothing from the file, why a file that was there was not used", async () => {
    const logged: Array<[string, unknown]> = [];
    for (const [text, reason] of [["not json", "unreadable"], [causesFile({ candidateDigest: OTHER }), "other_code"]] as const) {
      const w = world(text);
      await keepEvidence({ ...w.deps, log: (event, fields) => { logged.push([event, fields]); } }, input());
      expect(logged.at(-1)).toEqual(["evidence.failure_causes_not_used", { reason }]);
    }
    const quiet = world(undefined);
    const before = logged.length;
    await keepEvidence({ ...quiet.deps, log: (event, fields) => { logged.push([event, fields]); } }, input());
    expect(logged.slice(before).filter(([event]) => event === "evidence.failure_causes_not_used")).toEqual([]);
  });

  it("are dropped for a check the broker's own report says did not fail, and the tests part stays out with its disagreement", async () => {
    const w = world(causesFile());
    await keepEvidence(w.deps, { ...input(), checks: [entry({ after: "passed", class: "passing", exitCode: 0 })] });
    const pack = await loadEvidencePack(w.deps.store.blobs, TASK, DIGEST);
    expect(JSON.stringify(pack)).not.toContain("failureCauses");
  });
});
