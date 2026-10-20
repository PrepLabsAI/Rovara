import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "@agentx/contracts";
import { createE2EApplicationCollectionOracleFromCompiledSuite } from "@agentx/verifier";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import type { ObservedApiOutcome } from "../support/e2e-application-evidence-fixture.js";
import { startApplicationRound, type ApplicationRound } from "../support/e2e-application-round-harness.js";

// One application, two accounts of it (orders-owner and orders-viewer), one target and one scenario for each: the plan shape of a multi-role test of one application. Every
// per-case fact that depends on the account (its runtime account reference above all) must come from the case's own account, never from the application's first one.

afterEach(disposeRealCandidates);

const ACCOUNTS = ["orders-owner", "orders-viewer"] as const;
const PASS = { kind: "http-status", status: 200 } as const satisfies ObservedApiOutcome;
const two = () => startApplicationRound({ accounts: ACCOUNTS });
const brokerModule = () => import("../../packages/broker/src/aws/broker.js");

/** Everything the broker's own recollection builds the oracle from, for the round's one group, with each case observed as passing. */
async function collectedGroup(round: ApplicationRound) {
  expect(round.groupIds).toHaveLength(1);
  return round.collectGroup(round.groupIds[0]!, [PASS, PASS]);
}

type OracleInput = Parameters<typeof createE2EApplicationCollectionOracleFromCompiledSuite>[0];
function oracleInputOf(group: Awaited<ReturnType<typeof collectedGroup>>, edit: (compiled: OracleInput["compiled"]) => OracleInput["compiled"] = (compiled) => compiled): OracleInput {
  const inputs = group.collectionInputs as unknown as Omit<OracleInput, "compiled" | "binding" | "round">;
  return { compiled: edit(group.compiled), binding: group.binding, round: group.round, environment: inputs.environment, usage: inputs.usage, limits: inputs.limits,
    expectedSupervisorReceiptRefs: inputs.expectedSupervisorReceiptRefs, ownedResourceInventoryDigest: inputs.ownedResourceInventoryDigest,
    observationBindings: inputs.observationBindings, assertionAssets: inputs.assertionAssets, governedModelReceipts: inputs.governedModelReceipts, ownedClosedAt: inputs.ownedClosedAt };
}

/** The compiled suite with its admitted runtime account references replaced (the rest of the compiled suite is the admitted one). */
const withAccountRefs = (compiled: OracleInput["compiled"], edit: (refs: typeof compiled.runtimeAdmissionContext.selectionInput.runtimeAccountRefs) => typeof refs) => ({
  ...compiled, runtimeAdmissionContext: { ...compiled.runtimeAdmissionContext, selectionInput: { ...compiled.runtimeAdmissionContext.selectionInput,
    runtimeAccountRefs: edit(compiled.runtimeAdmissionContext.selectionInput.runtimeAccountRefs) } } }) as typeof compiled;

describe("one application with two accounts, one scenario on each", () => {
  it("is admitted as two cases, one per account of the one application", async () => {
    const round = await two();
    const cases = round.admission.groups.flatMap((group) => group.outerBinding.expectedCases);
    expect(cases.map((item) => item.accountProfileId).sort()).toEqual([...ACCOUNTS]);
    expect(new Set(round.admission.selectionInput.intent.applicationRuntimeRefs.map((ref) => ref.applicationId)).size).toBe(1);
    expect(round.admission.selectionInput.runtimeAccountRefs.map((ref) => ref.profileId).sort()).toEqual([...ACCOUNTS]);
  });

  it("gives each case the account reference of its own account, and holds each case's protected binding to it", async () => {
    const round = await two();
    const group = await collectedGroup(round);
    const oracle = createE2EApplicationCollectionOracleFromCompiledSuite(oracleInputOf(group));
    const refs = round.admission.selectionInput.runtimeAccountRefs;
    for (const expected of group.binding.expectedCases) {
      const facts = oracle.applicationIdsByCase.find((item) => item.caseId === expected.caseId)!;
      expect(facts.accountRef.profileId, expected.caseId).toBe(expected.accountProfileId);
      expect(canonicalJson(facts.accountRef)).toBe(canonicalJson(refs.find((ref) => ref.profileId === expected.accountProfileId)));
    }
    expect(new Set(oracle.applicationIdsByCase.map((item) => item.accountRef.profileId)).size).toBe(2);
    expect(group.collected.qualification?.status).toBe("PASS");
  });

  it("is refused, with a reason that names the account, when a case's account has no runtime account reference, or has more than one", async () => {
    const round = await two();
    const group = await collectedGroup(round);
    const missing = (compiled: OracleInput["compiled"]) => withAccountRefs(compiled, (refs) => refs.filter((ref) => ref.profileId !== "orders-viewer"));
    const duplicated = (compiled: OracleInput["compiled"]) => withAccountRefs(compiled, (refs) => [...refs, { ...refs.find((ref) => ref.profileId === "orders-viewer")!, revision: 2 }]);
    for (const [label, edit] of [["no", missing], ["more than one", duplicated]] as const) {
      let thrown: unknown;
      try { createE2EApplicationCollectionOracleFromCompiledSuite(oracleInputOf(group, edit)); } catch (error) { thrown = error; }
      expect(thrown, label).toBeInstanceOf(Error);
      // The compiled suite's own validation refuses an account list that is not the approved one before the oracle looks a case's account up; the oracle's lookup
      // (exactly one match) is the second line, with its own specific reason. Either way the group is UNKNOWN (the broker turns the refusal into the group's reason).
      expect((thrown as Error).message, label).toMatch(/runtime account/);
    }
  });

  it("passes the broker's own verification of the whole round", async () => {
    const round = await two();
    const group = await collectedGroup(round);
    round.markRunning();
    const uploaded = await round.upload(round.groupEnvelope(group.groupRun), { groupRunId: group.runId });
    expect(uploaded.response.status, JSON.stringify(uploaded.response.body)).toBe(200);
    const aggregate = await round.upload(round.aggregateEnvelope([JSON.parse(JSON.stringify(group.groupRun)) as Record<string, unknown>]));
    expect(aggregate.response.status, JSON.stringify(aggregate.response.body)).toBe(200);
    await round.finishChecks(aggregate.response.body as { key: string; sha256: string });
    expect(round.workflowNow(), JSON.stringify(round.workflowNow())).toMatchObject({ stage: "REVIEW" });
    expect((round.workflowNow().e2e as { qualifiedRound?: unknown }).qualifiedRound).toBeDefined();
    // The authority check the verdict stands on also holds for the planner-shaped stored plan.
    const broker = await brokerModule();
    const diagnostic: { reason?: string } = {};
    expect(await broker.workflowE2EApplicationAuthorityIsValid(round.harness.brokerInput as never, round.taskNow() as never, round.candidate, round.admission, diagnostic), diagnostic.reason).toBe(true);
  });
});
