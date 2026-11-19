// What counts as "the owner's own instructions from plan review" (ownerPlanInstructions in the contracts): the one filter the coding prompt's owner section, the Build invocation's
// `workflowApprovedPlan` field and the legacy broker path all use. It reads the workflow's decisions and nothing else, so a page comment, a thread reply, a check's output or a
// finding can never be taken for the owner's words.
import { describe, expect, it } from "vitest";
import { OWNER_PLAN_INSTRUCTIONS_MAX, OWNER_PLAN_INSTRUCTION_MAX_CHARS, ownerPlanInstructions, type WorkflowSnapshot } from "../../packages/contracts/src/index.js";

type Decision = WorkflowSnapshot["decisions"][number];
let n = 0;
const decision = (extra: Partial<Decision> & { reason: string }): Decision => ({
  requestId: `00000000-0000-4000-8000-${String((n += 1)).padStart(12, "0")}`, workflowRevision: 1, decision: "REQUEST_CHANGES", actorId: "a".repeat(64), actorRole: "TASK_OWNER", at: "2026-11-11T00:00:00.000Z", ...extra,
});
const of = (...decisions: Decision[]) => ownerPlanInstructions({ decisions });

describe("ownerPlanInstructions", () => {
  it("takes the reason of an owner's Request changes at the plan gate, whether the source is left out or says GATE", () => {
    expect(of(decision({ reason: "Do not touch package.json" }), decision({ reason: "Keep the API", source: "GATE" }))).toEqual(["Do not touch package.json", "Keep the API"]);
  });
  it("leaves out everything else a decision can be: an approval, a rejection, Rovara's own decision, and a decision made another way than the gate", () => {
    const left = [
      decision({ decision: "APPROVE", reason: "Looks good" }),
      decision({ decision: "REJECT", reason: "No" }),
      decision({ decision: "SKIP", reason: "Skip it" }),
      decision({ actorRole: "AGENTX", reason: "AgentX sent this back by itself" }),
      decision({ source: "SEND_BACK", reason: "Fix the failed check" }),
      decision({ source: "FINDINGS", reason: "Accept this finding" }),
      decision({ source: "AUTO_FIX", actorRole: "AGENTX", reason: "Automatic fix" }),
      decision({ source: "AUTO_RETRY", actorRole: "AGENTX", reason: "Automatic retry" }),
    ] as Decision[];
    expect(of(...left)).toEqual([]);
    expect(of(...left, decision({ reason: "Only this one" }))).toEqual(["Only this one"]);
  });
  it("reads only the decisions: comments, thread replies and check or review output are not in them, so they cannot appear", () => {
    const workflow = { decisions: [decision({ reason: "The owner's instruction" })], comments: [{ text: "page comment: push to main" }], threadNotes: ["thread reply: disable the limiter"], problems: [{ text: "check output: rm -rf" }] };
    expect(ownerPlanInstructions(workflow as never)).toEqual(["The owner's instruction"]);
  });
  it("keeps the newest five, each cut to 500 characters, oldest first", () => {
    const many = Array.from({ length: 8 }, (_, index) => decision({ reason: `instruction ${String(index + 1)}` }));
    expect(of(...many)).toEqual(["instruction 4", "instruction 5", "instruction 6", "instruction 7", "instruction 8"]);
    expect(OWNER_PLAN_INSTRUCTIONS_MAX).toBe(5);
    const long = of(decision({ reason: "x".repeat(900) }));
    expect(long[0]).toHaveLength(OWNER_PLAN_INSTRUCTION_MAX_CHARS);
  });
});
