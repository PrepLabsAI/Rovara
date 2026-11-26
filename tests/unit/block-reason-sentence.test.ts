// CHECK-AND-WORDING (b): every reason shown after "Stopped." reads as a sentence. One shared formatter (`blockReasonSentence`) is used wherever a reason is shown; a reason stored in lower case before
// the wording changed is reworded at display (no data migration), a reason that is already a sentence is unchanged, and a full stop is never doubled.
import { describe, expect, it } from "vitest";
import {
  CHECKS_BROKEN_LEGACY_REASON, CHECKS_NOT_PASSED_LEGACY_REASON, CHECKS_NOT_PASSED_REASON, WORKFLOW_BLOCK_REASONS, blockReasonSentence,
} from "../../packages/contracts/src/index.js";
import { attentionOf } from "../../packages/broker/src/core-host/app/attention.js";
import { plainBlockReason } from "../../packages/broker/src/developer/workflow-messages.js";
import { nextFor } from "../../packages/mcp/src/tools.js";
import { ORG, mergeWorld } from "../support/merge-world.js";

describe("blockReasonSentence", () => {
  it("makes a stored lower-case reason a sentence: a capital first letter and a full stop", () => {
    expect(blockReasonSentence("candidate checks failed or have unknown results")).toBe("Candidate checks failed or have unknown results.");
    expect(blockReasonSentence("the checks couldn't run")).toBe("The checks couldn't run.");
    expect(blockReasonSentence("rovara stopped while checking the code")).toBe("Rovara stopped while checking the code.");
    expect(blockReasonSentence("Rovara stopped while planning: the model did not answer")).toBe("Rovara stopped while planning: the model did not answer.");
  });

  it("leaves a reason that is already a sentence as it is, and never doubles the full stop", () => {
    for (const sentence of ["The plan couldn't be read.", "Did the run stop?", "Stop now!", "It stopped...", "It stopped (twice).", "He said \"stop.\"", "Rovara stopped.", "It ended…"]) {
      expect(blockReasonSentence(sentence)).toBe(sentence);
    }
    expect(blockReasonSentence("The checks couldn't run..")).toBe("The checks couldn't run..");
    expect(blockReasonSentence(blockReasonSentence("the plan couldn't be read"))).toBe("The plan couldn't be read.");
    expect(blockReasonSentence("  spaced out  ")).toBe("Spaced out.");
    expect(blockReasonSentence("")).toBe("");
    expect(blockReasonSentence("   ")).toBe("");
  });

  it("does not change a first character that is not a letter", () => {
    expect(blockReasonSentence("`npm test` failed")).toBe("`npm test` failed.");
    expect(blockReasonSentence("3 checks failed")).toBe("3 checks failed.");
    expect(blockReasonSentence("échec du test")).toBe("Échec du test.");
  });

  it("is what every reason Rovara writes now already is: a sentence", () => {
    for (const reason of [...Object.values(WORKFLOW_BLOCK_REASONS), CHECKS_NOT_PASSED_REASON]) {
      expect(blockReasonSentence(reason), reason).toBe(reason);
    }
  });
});

describe("the places that show a reason", () => {
  const blockedTask = async (blockReason: string) => {
    const world = await mergeWorld({ pullRequests: [] });
    const task = { ...(await world.task()), workflow: { stage: "VERIFY", state: "BLOCKED", revision: 2, definitionVersion: "1", path: "QUICK", blockReason } };
    return { world, task: task as never };
  };

  it("the task page's ask shows a stored lower-case reason as a sentence, an already-correct one unchanged, with no double full stop", async () => {
    for (const [stored, shown] of [
      [CHECKS_NOT_PASSED_LEGACY_REASON, "Candidate checks failed or have unknown results."],
      [CHECKS_BROKEN_LEGACY_REASON, "The checks couldn't run."],
      [CHECKS_NOT_PASSED_REASON, CHECKS_NOT_PASSED_REASON],
      ["Rovara stopped while planning: the model stopped.", "Rovara stopped while planning: the model stopped."],
    ] as const) {
      const { world, task } = await blockedTask(stored);
      const attention = await attentionOf({ store: world.store, companyId: ORG }, task);
      expect(attention.view.ask?.lines[0]).toBe(shown);
      expect(attention.view.ask?.lines[0]).not.toMatch(/\.\.$/u);
    }
  });

  it("the Slack words reword the reasons stored before their wording changed", () => {
    expect(plainBlockReason(CHECKS_BROKEN_LEGACY_REASON)).toBe("The checks couldn't run.");
    expect(plainBlockReason(WORKFLOW_BLOCK_REASONS.checksBroken)).toBe("The checks couldn't run.");
  });

  it("the AI tool's next step says a stored lower-case reason as a sentence, with a single full stop", () => {
    const task = (blockReason: string | undefined) => ({ workflow: { stage: "VERIFY", state: "BLOCKED", revision: 4, blockReason } }) as never;
    for (const stored of [CHECKS_BROKEN_LEGACY_REASON, CHECKS_BROKEN_LEGACY_REASON + ".", WORKFLOW_BLOCK_REASONS.checksBroken]) {
      const text = nextFor(task(stored));
      expect(text).toContain("The checks are blocked. The checks couldn't run. Run them again");
      expect(text).not.toContain("..");
    }
    expect(nextFor(task(undefined))).toContain("The checks are blocked. Their results are unknown. Run them again");
  });
});
