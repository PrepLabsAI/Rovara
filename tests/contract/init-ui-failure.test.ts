// tests/contract/init-ui-failure.test.ts
// Spec 048 FR-060: what a failure screen says, kept in plain words, with raw messages, codes and
// stack names in the technical details.
import { describe, expect, it } from "vitest";
import { agentXError } from "@agentx/contracts";
import { askFailureAction, failureScreen, plainReason } from "../../packages/cli/src/init/ui/failure.js";
import { scriptedPrompter } from "../support/init-fakes.js";

describe("the failure screen", () => {
  it("says what happened in plain words, what to do, and keeps the raw message and the stacks in the details", () => {
    const screen = failureScreen({ env: "staging", region: "us-east-1", stepTitle: "Start the AgentX service", stepId: "control-plane", error: new Error("Resource limit exceeded"), logPath: "/home/a/.agentx/logs/init-staging.log" });
    expect(screen).toEqual({
      title: "The install stopped",
      what: "Start the AgentX service did not finish. Resource limit exceeded.",
      next: "Nothing is lost: the steps that finished are kept. Try this step again, or stop for now and continue later.",
      details: ["Resource limit exceeded", "Stack: agentx-staging-control-plane", "Stack: agentx-staging-runtime", "Log file: /home/a/.agentx/logs/init-staging.log"],
      link: { url: "https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks?filteringText=agentx-staging-", label: "Open the stacks in the AWS console" },
    });
  });

  it("keeps error codes, ARNs and flags out of what happened", () => {
    // Any AgentXError code is stripped the same way; CONFIG_INVALID is the codebase's own code for
    // a release's image problem (see prerequisites.ts), used here only to exercise plainReason.
    expect(plainReason(agentXError("CONFIG_INVALID", "image x is not a public.ecr.aws/ reference"))).toBe("Image x is not a public.ecr.aws/ reference.");
    expect(plainReason(new Error("AccessDenied for arn:aws:iam::123456789012:role/x"))).toBeUndefined();
    expect(plainReason(new Error("--account 1 does not match"))).toBeUndefined();
    expect(failureScreen({ env: "staging", region: "us-east-1", error: new Error("--account 1 does not match") })).toMatchObject({
      what: "The install could not go on.", next: "Your progress is saved. Stop for now and continue later.", details: ["--account 1 does not match"],
    });
  });

  it("offers Try this step again only for a step that can run again in place, and stops when no one answers", async () => {
    await expect(askFailureAction(scriptedPrompter(["retry"]), { retry: true })).resolves.toBe("retry");
    await expect(askFailureAction(scriptedPrompter([]), { retry: true })).resolves.toBe("stop");
    await expect(askFailureAction(scriptedPrompter(["retry"]), { retry: false })).resolves.toBe("stop");
  });
});
