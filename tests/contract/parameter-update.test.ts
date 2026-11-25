import { describe, expect, it } from "vitest";
import { updateStackParameters, type ParameterChange } from "../../packages/cli/src/deploy/parameter-update.js";
import { fakeCloudFormation } from "../support/fake-cloudformation.js";

const STACK = "agentx-staging-control-plane";
const ROLE = "arn:aws:iam::123456789012:role/agentx-staging-cloudformation";

const run = (cloudFormation: ReturnType<typeof fakeCloudFormation>, changes: Record<string, string>, confirm: (event: { parameters: ParameterChange[] }) => Promise<boolean> = async () => true) =>
  updateStackParameters({ cloudFormation, stackName: STACK, roleArn: ROLE, changes, confirm, write: () => undefined, sleep: async () => undefined, pollMs: 1 });

describe("parameter-only stack updates (R6)", () => {

  it("refuses a stack deployed from a release without developer sign-in, naming the missing parameter", async () => {
    const cf = fakeCloudFormation({ parameters: { CallbackSigningKey: "****" } });
    await expect(run(cf, { SlackTeamId: "T0TEAM1" })).rejects.toThrow(`stack ${STACK} was deployed from an AgentX release without developer sign-in (it has no SlackTeamId parameter); upgrade the environment to a release with developer sign-in, then run this again`);
  });

  it.each([
    ["UPDATE_IN_PROGRESS", /is busy \(UPDATE_IN_PROGRESS\); try again when it finishes/],
    ["UPDATE_ROLLBACK_FAILED", /is UPDATE_ROLLBACK_FAILED; fix it in the CloudFormation console first/],
  ])("refuses a stack that is %s", async (status, message) => {
    await expect(run(fakeCloudFormation({ status }), { SlackTeamId: "T0TEAM1" })).rejects.toThrow(message);
  });

  it("refuses a stack that does not exist", async () => {
    await expect(run(fakeCloudFormation({ absent: true }), { SlackTeamId: "T0TEAM1" })).rejects.toThrow(/does not exist; install the environment first/);
  });

  it("treats a change set with no changes as done", async () => {
    const cf = fakeCloudFormation({ changeSet: { status: "FAILED", reason: "The submitted information didn't contain changes." } });
    expect(await run(cf, { SlackTeamId: "T0TEAM1" })).toEqual({ changed: false });
  });

  it("treats a ChangeSetNotFound error after execute as finished, falling back to the stack's own status", async () => {
    const cf = fakeCloudFormation();
    let executed = false;
    let afterExecuteDescribes = 0;
    const flaky = {
      async send(command: Parameters<typeof cf.send>[0]) {
        const name = command.constructor.name;
        if (name === "ExecuteChangeSetCommand") executed = true;
        if (executed && name === "DescribeChangeSetCommand") {
          afterExecuteDescribes++;
          if (afterExecuteDescribes === 1) throw Object.assign(new Error("ChangeSet [agentx-signin/1] does not exist"), { name: "ChangeSetNotFoundException" });
        }
        return cf.send(command);
      },
    };
    const result = await updateStackParameters({ cloudFormation: flaky, stackName: STACK, roleArn: ROLE, changes: { SlackTeamId: "T0TEAM1" }, confirm: async () => true, write: () => undefined, sleep: async () => undefined, pollMs: 1 });
    expect(result).toEqual({ changed: true });
  });

  // Spec 025 E16: McpConfirmElicitation is declared only by named environments' templates, so the
  // legacy deployment is told the setting is not there, not to upgrade.
  it("says a named-environment-only setting does not exist on the legacy deployment", async () => {
    const cf = fakeCloudFormation({ parameters: { CallbackSigningKey: "****" } });
    const legacy = (changes: Record<string, string>) =>
      updateStackParameters({ cloudFormation: cf, stackName: "AgentXControlPlane", roleArn: ROLE, changes, label: "config", confirm: async () => true, write: () => undefined, sleep: async () => undefined, pollMs: 1 });
    await expect(legacy({ McpConfirmElicitation: "disabled" })).rejects.toThrow("stack AgentXControlPlane has no McpConfirmElicitation parameter; that setting exists only in environments installed with agentx init, not in the legacy deployment; nothing changed");
    expect(cf.calls.map((call) => call.name)).toEqual(["DescribeStacksCommand"]);
    // Any other missing parameter on the legacy stack keeps the upgrade advice.
    await expect(legacy({ BudgetScope: "tag" })).rejects.toThrow("stack AgentXControlPlane has no BudgetScope parameter; it runs an older AgentX release, so upgrade it with agentx upgrade, then run this again");
  });

  // CODE-PUBLIC-URL (DEC 254zzz505): the issuer follows PublicApiUrl, so changing it on a running stack is an issuer change and needs an explicit confirm.
  describe("PublicApiUrl (the guard on changing it on a running install)", () => {
    const origin = "https://api.example.dev";
    const confirmed = (cf: ReturnType<typeof fakeCloudFormation>, changes: Record<string, string>) =>
      updateStackParameters({ cloudFormation: cf, stackName: STACK, roleArn: ROLE, changes, confirm: async () => true, write: () => undefined, sleep: async () => undefined, pollMs: 1, confirmPublicApiUrlChange: true });

    it.each([["", origin], [origin, "https://api.other.dev"], [origin, ""]])("refuses %j to %j without the confirm, naming the issuer consequences, and creates no change set", async (from, to) => {
      const cf = fakeCloudFormation({ parameters: { PublicApiUrl: from } });
      const refusal = run(cf, { PublicApiUrl: to });
      await expect(refusal).rejects.toThrow(/changes its token issuer: Cloud's sealed company AI keys, spend meters and Bedrock external ids are keyed on the issuer/u);
      await expect(refusal).rejects.toThrow(/--confirm-public-api-url-change/u);
      expect(cf.calls.map((call) => call.name)).toEqual(["DescribeStacksCommand"]);
    });

    it("applies the change with the explicit confirm", async () => {
      const cf = fakeCloudFormation({ parameters: { PublicApiUrl: "" } });
      expect(await confirmed(cf, { PublicApiUrl: origin })).toEqual({ changed: true });
      expect(cf.calls.map((call) => call.name)).toContain("CreateChangeSetCommand");
    });

    it("needs no confirm where the value does not change", async () => {
      const cf = fakeCloudFormation({ parameters: { PublicApiUrl: origin } });
      expect(await run(cf, { PublicApiUrl: origin })).toEqual({ changed: false });
    });

    it("does not guard another parameter", async () => {
      const cf = fakeCloudFormation({ parameters: { PublicApiUrl: origin, SlackTeamId: "" } });
      expect(await run(cf, { SlackTeamId: "T0TEAM1" })).toEqual({ changed: true });
    });
  });

});
