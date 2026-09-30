import { Stack } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { normalizedTemplate } from "../support/template-snapshot.js";

// Issue 157 changes the Slack service's code only. These snapshots were recorded from mainline
// 667ab1d before the change, so a named environment's templates must stay as they were.
describe("named environment templates", () => {
  const stacks = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child));
  for (const stack of stacks) {
    it(`${stack.stackName} is unchanged`, () => {
      expect(normalizedTemplate(stack)).toMatchSnapshot();
    }, 120_000);
  }
});
