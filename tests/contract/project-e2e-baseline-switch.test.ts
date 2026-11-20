import { describe, expect, it } from "vitest";
import { DeveloperTaskPolicySchema, ProjectDefinitionSchema, developerTaskPolicy } from "@agentx/contracts";

// M1.3 Task 3.7b, owner decision D2: the baseline round "can be switched off per project". The switch is part of the project's developer-task policy, not of its E2E policy, because
// the E2E policy is bound by digest to the approved setup and a switch that needed the setup approved again would not be a switch.

describe("the per-project switch of the baseline round", () => {

  it("is accepted by the project definition and read back through the policy", () => {
    const parsed = DeveloperTaskPolicySchema.parse({ e2eBaselineRound: false });
    expect(parsed.e2eBaselineRound).toBe(false);
    expect(developerTaskPolicy({ developerTasks: { e2eBaselineRound: false } }).e2eBaselineRound).toBe(false);
    expect(ProjectDefinitionSchema.shape.developerTasks.safeParse({ e2eBaselineRound: false }).success).toBe(true);
    expect(DeveloperTaskPolicySchema.safeParse({ e2eBaselineRound: "no" }).success).toBe(false);
  });

});
