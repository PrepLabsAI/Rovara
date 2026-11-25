// DEC 254zzz495 (N3), rollback-safe design: the fact is an attribute of a revision ROW. A candidate carries it only while it has no test command (the confirm's own, else the base revision's live fact), so it can never come back
// without a setup a person approved; the nightly exemption holds only while the night's approved environment has no test-kind check, and reads the row.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, change, projectRevisionKey, type ProjectDefinition } from "@agentx/contracts";
import { noTestsOfCandidate, type StoreCandidateInput } from "../../packages/broker/src/core/setup-agent/apply.js";
import { hasTestCheck, projectHasNoAutomatedTests } from "../../packages/broker/src/core/test-env/nightly.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { orgProjectCatalogKey } from "@agentx/contracts";

const FACT = { at: "2026-11-24T10:00:00.000Z", looked: ["tests_folder" as const] };
const OWN = { at: "2026-11-24T11:00:00.000Z", looked: ["makefile" as const] };
const test = { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 600 };
const definition = (readiness: ProjectDefinition["readiness"], revision: number): ProjectDefinition => ({
  name: "payments", revision, setup: [], readiness, orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
});

async function world(readinessOfLatest: ProjectDefinition["readiness"] = []) {
  const store = new MemoryDocumentStore();
  await store.put({ item: { ...projectRevisionKey(IMPLICIT_COMPANY_ID, "payments", 1), entityType: "PROJECT", definition: definition(readinessOfLatest, 1) as never, noAutomatedTests: FACT } });
  await store.put({ item: { ...orgProjectCatalogKey(IMPLICIT_COMPANY_ID, "payments"), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
  return store;
}
const input = (candidate: ProjectDefinition, own?: typeof OWN): StoreCandidateInput => ({ project: "payments", by: "p", requestId: "r", taskId: "t", baseRevision: 1, candidate, replyExtra: {}, alsoTransact: [], ...(own === undefined ? {} : { noAutomatedTests: own }) });

describe("what a candidate's revision row carries", () => {
  it("carries the base revision's fact while the candidate has no test command (a plan update that keeps no tests keeps 'Ready, no automated tests')", async () => {
    const store = await world();
    expect(await noTestsOfCandidate({ store, companyId: IMPLICIT_COMPANY_ID }, input(definition([], 2)))).toEqual(FACT);
  });
  it("the confirm's own fact wins over the base's", async () => {
    const store = await world();
    expect(await noTestsOfCandidate({ store, companyId: IMPLICIT_COMPANY_ID }, input(definition([], 2), OWN))).toEqual(OWN);
  });
  it("carries nothing once the candidate has a test command, whatever the base held or the confirm named", async () => {
    const store = await world();
    expect(await noTestsOfCandidate({ store, companyId: IMPLICIT_COMPANY_ID }, input(definition([test], 2)))).toBeUndefined();
    expect(await noTestsOfCandidate({ store, companyId: IMPLICIT_COMPANY_ID }, input(definition([test], 2), OWN))).toBeUndefined();
  });
  it("a base row that holds a fact its schema does not read gives none", async () => {
    const store = await world();
    await store.update({ key: projectRevisionKey(IMPLICIT_COMPANY_ID, "payments", 1), ops: [change.set("noAutomatedTests", { at: "x", looked: ["../etc"] })] });
    expect(await noTestsOfCandidate({ store, companyId: IMPLICIT_COMPANY_ID }, input(definition([], 2)))).toBeUndefined();
  });
});

describe("the nightly exemption", () => {
  it("is for a project whose LIVE revision has the fact and no test command, read from the row; a revision that gained a test command, or a project without the fact, is not", async () => {
    const deps = { store: await world() };
    expect(await projectHasNoAutomatedTests(deps, IMPLICIT_COMPANY_ID, "payments")).toBe(true);
    expect(await projectHasNoAutomatedTests({ store: await world([test]) }, IMPLICIT_COMPANY_ID, "payments")).toBe(false);
    expect(await projectHasNoAutomatedTests(deps, IMPLICIT_COMPANY_ID, "other")).toBe(false);
  });
  it("holds only while the night's approved environment has no test-kind check", () => {
    expect(hasTestCheck({ repos: [{ checks: [{ kind: "smoke" }, { kind: "lint" }] }] })).toBe(false);
    expect(hasTestCheck({ repos: [{ checks: [] }, { checks: [{ kind: "test" }] }] })).toBe(true);
    expect(hasTestCheck({ repos: [] })).toBe(false);
  });
});
