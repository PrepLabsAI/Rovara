// LIVEFIX-1 item 2 (AUTOFIXGAP), on the real broker: the CHECKS dispatch refuses the round before it starts (VERIFY WAITING -> BLOCKED), and that block is looked at by the automatic-fix policy as
// a block written by a finished run is. The live case: the coding round left the approved application with no launch recipe in the source ("has no launch recipe in the approved source").
import { afterEach, describe, expect, it } from "vitest";
import { WORKFLOW_AGENTX_ACTOR_ID, workflowApplicationEvidenceCodes, type WorkflowSnapshot } from "@agentx/contracts";
import { AutoFixAskSchema } from "../../packages/broker/src/developer/autofix-messages.js";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { startApplicationRound, type RoundBrokerHarness } from "../support/e2e-application-round-harness.js";

afterEach(async () => { await disposeRealCandidates(); });

type Config = { enabled: boolean; capUsd: number; roundEstimateUsd: number };
const ON: Config = { enabled: true, capUsd: 1000, roundEstimateUsd: 3 };
/** The coding round changed package.json so that the approved application no longer declares how to launch (no project contract, no start script). */
const withoutLaunchRecipe = (files: Record<string, string>) => ({ ...files, "api-a/package.json": JSON.stringify({ name: "@acme/a", version: "1.0.0", dependencies: { express: "4.0.0" } }) });

/** Runs the round to its first dispatch, which the candidate's missing recipe refuses; returns the harness the dispatch ran on. */
async function refusedRound(autofix: Config | undefined) {
  let seen: RoundBrokerHarness | undefined;
  await expect(startApplicationRound({
    candidateTree: withoutLaunchRecipe,
    ...(autofix === undefined ? {} : { brokerExtra: { autofix } }),
    beforeDispatch: (harness) => { seen = harness; },
  })).rejects.toThrow(/the dispatch started 0 CHECKS operations/);
  const harness = seen!;
  const record = harness.db.find((item) => item.entityType === "DEVELOPER_TASK")[0]!;
  const taskId = String(record.taskId);
  const task = () => harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot; autofixAsk?: unknown; workspaceId: string };
  const rows = () => harness.db.find((item) => item.pk === "WORKFLOW_DISPATCH");
  return { harness, taskId, task, rows, workspaceId: String(record.workspaceId) };
}

describe("a CHECKS dispatch refusal is decided by automatic fixing like any other blocked step (AUTOFIXGAP)", () => {
  it("sends the work back to coding by itself when the coding round left the approved application with no launch recipe (the exact live case)", async () => {
    const round = await refusedRound(ON);
    const workflow = round.task().workflow;
    // Rovara acted: one AGENTX send back for the refused round, and the coder is running again. Without the fix the task sat in VERIFY/BLOCKED with nobody looking at it.
    expect(workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    const automatic = workflow.decisions.filter((decision) => decision.source === "AUTO_FIX");
    expect(automatic).toHaveLength(1);
    expect(automatic[0]).toMatchObject({ actorRole: "AGENTX", actorId: WORKFLOW_AGENTX_ACTOR_ID, decision: "REQUEST_CHANGES", auto: { stage: "VERIFY" } });
    // It was this block that was decided: the refused round's reason, written by the dispatch before the round started.
    expect(automatic[0]!.workflowRevision).toBeGreaterThan(0);
    const coding = round.harness.db.find((item) => item.pk === `WORKSPACE#${round.workspaceId}` && item.entityType === "OPERATION" && item.workflowMode === "IMPLEMENT" && item.requestId === automatic[0]!.requestId);
    expect(coding).toHaveLength(1);
    const outbox = round.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === coding[0]!.id)[0];
    const prompt = String((outbox?.invocation as { payload: { prompt: string } }).payload.prompt);
    expect(prompt).toContain("could not be started");
    expect(prompt).toContain("no launch recipe");
    // The look is done and the row removed; nothing is left to sweep.
    expect(round.rows()).toEqual([]);
    expect(round.task().autofixAsk).toBeUndefined();
  });

  it("asks the owner, with details, when automatic fixing may not act (here the money cap): the block still ends in an ask card, never in silence", async () => {
    const round = await refusedRound({ ...ON, capUsd: 0.5 });
    const workflow = round.task().workflow;
    expect(workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(workflowApplicationEvidenceCodes(workflow.blockReason ?? "")).toBeUndefined();
    expect(workflow.blockReason).toContain("could not be started");
    expect(workflow.decisions.filter((decision) => decision.source === "AUTO_FIX" || decision.source === "AUTO_RETRY")).toEqual([]);
    const ask = AutoFixAskSchema.parse(round.task().autofixAsk);
    expect(ask).toMatchObject({ workflowRevision: workflow.revision, reason: "spend-cap", codes: ["round-refused"] });
    const card = workflowMessage({ taskId: round.taskId, workflow, autoFix: { ask } })!;
    expect(card.text).toContain("Why I'm asking you");
    expect(round.rows()).toEqual([]);
  });

  it("leaves the block as it was when automatic fixing is off: no row, no decision, the owner's card as before", async () => {
    const round = await refusedRound(undefined);
    expect(round.task().workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(round.task().workflow.blockReason).toContain("could not be started");
    expect(round.rows()).toEqual([]);
    expect(round.task().autofixAsk).toBeUndefined();
    expect(round.task().workflow.decisions.filter((decision) => decision.actorRole === "AGENTX")).toEqual([]);
  });
});
