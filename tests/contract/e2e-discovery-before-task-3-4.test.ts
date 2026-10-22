import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { E2ERepositoryInspectionSchema, E2ESetupProposalSchema, canonicalJson, createCandidateManifest, inspectE2ERepository, inspectE2ERepositoryBeforeContractApiTargets,
  proposeE2ESetup, verifyE2ESetupProposal } from "@agentx/contracts";
import { PROFILE } from "../support/e2e-application-plan-fixtures.js";

// Task 3.4 (Ruling DA): discovery proposes `api-1` for a web app whose project contract names it in `targetAccounts`. An inspection or setup proposal stored before that
// (`tests/fixtures/setup-proposals-before-task-3-4.json`, written by the code at 3153971f over the fixture apps) keeps verifying, byte for byte.
type Stored = { files: string[]; inspection: unknown; proposal: unknown; setupApproval: { artifactId: string; digest: string } };
const stored = JSON.parse(readFileSync(new URL("../fixtures/setup-proposals-before-task-3-4.json", import.meta.url), "utf8")) as Record<"orders-web-m13-app" | "orders-contract-app" | "accounts-app", Stored>;
const directoryOf = { "orders-web-m13-app": "orders-web-m13", "orders-contract-app": "e2e-web-api-app", "accounts-app": "e2e-accounts-app" } as const;
const snapshotFor = (name: keyof typeof stored) => {
  const candidate = createCandidateManifest([{ repositoryId: "example/demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
  const sources = stored[name].files.map((path) => { const bytes = readFileSync(new URL(`../fixtures/${directoryOf[name]}/${path}`, import.meta.url)); return { path, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), kind: "blob" as const }; });
  return { candidate, commitSha: "a".repeat(40), treeSha: "b".repeat(40), treeComplete: true as const, treePaths: sources.map((item) => item.path).sort(), sources };
};
const names = ["orders-web-m13-app", "orders-contract-app", "accounts-app"] as const;
const kindsOf = (targets: ReadonlyArray<{ kind: string; accountProfileId: string }>) => ({ web: targets.filter((target) => target.kind === "web").map((target) => target.accountProfileId).sort(),
  api: targets.filter((target) => target.kind === "api").map((target) => target.accountProfileId).sort() });

describe("inspections and setup proposals stored before a web app's contract could name its API target", () => {
  it.each(names)("verifies the stored proposal and inspection of the %s fixture unchanged", (name) => {
    const snapshot = snapshotFor(name);
    const proposal = E2ESetupProposalSchema.parse(stored[name].proposal);
    expect(stored[name].setupApproval.digest).toBe(createHash("sha256").update(canonicalJson(proposal)).digest("hex"));
    expect(verifyE2ESetupProposal(proposal, snapshot, snapshot.candidate)).toEqual(proposal);
    const inspection = E2ERepositoryInspectionSchema.parse(stored[name].inspection);
    const rebuilt = proposeE2ESetup({ inspection, snapshot, expectedCandidate: snapshot.candidate, readyProfiles: [{ kind: "web", profileId: PROFILE }] });
    expect(canonicalJson(rebuilt)).toBe(canonicalJson(proposal));
  });

  it.each(["orders-contract-app", "accounts-app"] as const)("derives the %s fixture exactly as it did: its contract names no API target, so nothing moved", (name) => {
    const snapshot = snapshotFor(name);
    expect(canonicalJson(inspectE2ERepository(snapshot, snapshot.candidate).inspection)).toBe(canonicalJson(stored[name].inspection));
    expect(canonicalJson(inspectE2ERepositoryBeforeContractApiTargets(snapshot, snapshot.candidate).inspection)).toBe(canonicalJson(stored[name].inspection));
  });

  it("derives the orders-web-m13 fixture differently now (it names api-1), while its stored inspection, written without it, still verifies", () => {
    const snapshot = snapshotFor("orders-web-m13-app");
    const before = E2ERepositoryInspectionSchema.parse(stored["orders-web-m13-app"].inspection);
    // As stored: one web target, the contract's account variants unbound, and the blocking input that said so.
    expect(before.proposedTargets.map((target) => target.targetId)).toEqual(["web-1"]);
    expect(before.missingInputs.map((input) => input.kind)).toEqual(["target-selection"]);
    const now = inspectE2ERepository(snapshot, snapshot.candidate).inspection;
    expect(canonicalJson(now)).not.toBe(canonicalJson(before));
    expect(now.proposedTargets.some((target) => target.targetId === "api-1" && target.kind === "api")).toBe(true);
    expect(now.missingInputs).toEqual([]);
    expect(canonicalJson(inspectE2ERepositoryBeforeContractApiTargets(snapshot, snapshot.candidate).inspection)).toBe(canonicalJson(before));
    expect(() => proposeE2ESetup({ inspection: before, snapshot, expectedCandidate: snapshot.candidate })).not.toThrow();
  });

  it("does not accept just any inspection: a stored one that is neither derivation is refused", () => {
    const snapshot = snapshotFor("orders-web-m13-app");
    const before = E2ERepositoryInspectionSchema.parse(stored["orders-web-m13-app"].inspection);
    const tampered = { ...before, proposedTargets: [{ ...before.proposedTargets[0]!, targetId: "web-9" }] };
    expect(() => proposeE2ESetup({ inspection: E2ERepositoryInspectionSchema.parse(tampered), snapshot, expectedCandidate: snapshot.candidate })).toThrow(/does not match source-derived/);
    const noApi = { ...inspectE2ERepository(snapshot, snapshot.candidate).inspection };
    noApi.proposedTargets = noApi.proposedTargets.filter((target) => target.kind !== "api");
    expect(() => proposeE2ESetup({ inspection: E2ERepositoryInspectionSchema.parse(noApi), snapshot, expectedCandidate: snapshot.candidate })).toThrow(/does not match source-derived/);
  });

  it("proposes the web and API target of every account for the orders-web-m13 fixture now, each with its signed-out variant derived on read", () => {
    const snapshot = snapshotFor("orders-web-m13-app");
    const proposal = proposeE2ESetup({ inspection: inspectE2ERepository(snapshot, snapshot.candidate).inspection, snapshot, expectedCandidate: snapshot.candidate,
      readyProfiles: [{ kind: "web", profileId: PROFILE }, { kind: "api", profileId: PROFILE }] });
    expect(proposal.state).toBe("proposed");
    expect(kindsOf(proposal.targets)).toEqual({ web: ["orders-owner", "orders-owner-b", "orders-viewer", "synthetic"], api: ["orders-owner", "orders-owner-b", "orders-viewer", "synthetic"] });
    expect(verifyE2ESetupProposal(proposal, snapshot, snapshot.candidate)).toEqual(proposal);
    // The API target is on the qualified profile like its web twin.
    expect(new Set(proposal.targets.map((target) => target.runtimeProfileId))).toEqual(new Set([PROFILE]));
  });
});
