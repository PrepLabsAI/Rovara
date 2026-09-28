import { describe, expect, it } from "vitest";
import { updateStackParameters, type ParameterChange } from "../../packages/cli/src/deploy/parameter-update.js";
import { fakeCloudFormation } from "../support/fake-cloudformation.js";

const STACK = "agentx-staging-control-plane";
const ROLE = "arn:aws:iam::123456789012:role/agentx-staging-cloudformation";

const run = (cloudFormation: ReturnType<typeof fakeCloudFormation>, changes: Record<string, string>, confirm: (event: { parameters: ParameterChange[] }) => Promise<boolean> = async () => true) =>
  updateStackParameters({ cloudFormation, stackName: STACK, roleArn: ROLE, changes, confirm, write: () => undefined, sleep: async () => undefined, pollMs: 1 });

describe("parameter-only stack updates (R6)", () => {
  it("keeps the template and every other parameter, including the NoEcho signing key, and shows what changes", async () => {
    const cf = fakeCloudFormation();
    const seen: ParameterChange[][] = [];
    const result = await run(cf, { SlackTeamId: "T0TEAM1", DeveloperSignInSlack: "enabled" }, async (event) => { seen.push(event.parameters); return true; });
    expect(result).toEqual({ changed: true });
    const create = cf.calls.find((call) => call.name === "CreateChangeSetCommand")!.input;
    expect(create).toMatchObject({ StackName: STACK, ChangeSetType: "UPDATE", UsePreviousTemplate: true, RoleARN: ROLE, Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"] });
    expect(create.Parameters).toEqual([
      { ParameterKey: "CallbackSigningKey", UsePreviousValue: true },
      { ParameterKey: "SlackTeamId", ParameterValue: "T0TEAM1" },
      { ParameterKey: "DeveloperSignInSlack", ParameterValue: "enabled" },
      { ParameterKey: "DeveloperOidcIssuer", UsePreviousValue: true },
    ]);
    expect(seen).toEqual([[{ name: "SlackTeamId", from: "", to: "T0TEAM1" }, { name: "DeveloperSignInSlack", from: "disabled", to: "enabled" }]]);
    expect(cf.calls.map((call) => call.name)).toContain("ExecuteChangeSetCommand");
  });

  it("does nothing when the values are already set", async () => {
    const cf = fakeCloudFormation({ parameters: { SlackTeamId: "T0TEAM1" } });
    expect(await run(cf, { SlackTeamId: "T0TEAM1" })).toEqual({ changed: false });
    expect(cf.calls.map((call) => call.name)).toEqual(["DescribeStacksCommand"]);
  });

  it("refuses a stack deployed from a release without developer sign-in, naming the missing parameter", async () => {
    const cf = fakeCloudFormation({ parameters: { CallbackSigningKey: "****" } });
    await expect(run(cf, { SlackTeamId: "T0TEAM1" })).rejects.toThrow(`stack ${STACK} was deployed from an AgentX release without developer sign-in (it has no SlackTeamId parameter); upgrade the environment to a release with developer sign-in, then run this again`);
  });

  it("asks for an upgrade, not for developer sign-in, when only the enabled-since parameters are missing (FR-045)", async () => {
    const cf = fakeCloudFormation({ parameters: { SlackTeamId: "", DeveloperSignInSlack: "disabled" } });
    await expect(run(cf, { SlackTeamId: "T0TEAM1", DeveloperSignInSlack: "enabled", DeveloperSignInSlackSince: "1790000000" })).rejects.toThrow(`stack ${STACK} was deployed from an older AgentX release (it has no DeveloperSignInSlackSince parameter); upgrade the environment with agentx deploy, then run this again`);
    expect(cf.calls.map((call) => call.name)).toEqual(["DescribeStacksCommand"]);
  });

  it.each([
    ["UPDATE_IN_PROGRESS", /is busy \(UPDATE_IN_PROGRESS\); try again when it finishes/],
    ["UPDATE_ROLLBACK_FAILED", /is UPDATE_ROLLBACK_FAILED; fix it in the CloudFormation console first/],
    ["ROLLBACK_COMPLETE", /is ROLLBACK_COMPLETE; fix it in the CloudFormation console first/],
  ])("refuses a stack that is %s", async (status, message) => {
    await expect(run(fakeCloudFormation({ status }), { SlackTeamId: "T0TEAM1" })).rejects.toThrow(message);
  });

  it("refuses a stack that does not exist", async () => {
    await expect(run(fakeCloudFormation({ absent: true }), { SlackTeamId: "T0TEAM1" })).rejects.toThrow(/does not exist; install the environment first/);
  });

  it("deletes the change set and changes nothing when declined", async () => {
    const cf = fakeCloudFormation();
    await expect(run(cf, { SlackTeamId: "T0TEAM1" }, async () => false)).rejects.toThrow(/not applied; nothing changed/);
    expect(cf.calls.map((call) => call.name)).toContain("DeleteChangeSetCommand");
    expect(cf.calls.map((call) => call.name)).not.toContain("ExecuteChangeSetCommand");
  });

  it("reports a failed update with what to do", async () => {
    await expect(run(fakeCloudFormation({ finalStatus: "UPDATE_ROLLBACK_COMPLETE" }), { SlackTeamId: "T0TEAM1" })).rejects.toThrow(/ended in UPDATE_ROLLBACK_COMPLETE; sign-in did not change/);
  });

  it("treats a change set with no changes as done", async () => {
    const cf = fakeCloudFormation({ changeSet: { status: "FAILED", reason: "The submitted information didn't contain changes." } });
    expect(await run(cf, { SlackTeamId: "T0TEAM1" })).toEqual({ changed: false });
  });

  it("does not mistake an inherited Object.prototype member for a requested change (Object.hasOwn, not `in`)", async () => {
    // A deployed parameter literally named "toString" is contrived, but `"toString" in changes` is
    // true for any plain object even when `changes` never mentions it (it is inherited from
    // Object.prototype), which would wrongly send it as a changed value instead of UsePreviousValue.
    const cf = fakeCloudFormation({ parameters: { CallbackSigningKey: "****", SlackTeamId: "", toString: "unchanged" } });
    await run(cf, { SlackTeamId: "T0TEAM1" });
    const create = cf.calls.find((call) => call.name === "CreateChangeSetCommand")!.input;
    expect(create.Parameters).toContainEqual({ ParameterKey: "toString", UsePreviousValue: true });
  });

  it("rethrows a non-ChangeSetNotFound error while polling execution, instead of treating it as done", async () => {
    const cf = fakeCloudFormation();
    let executed = false;
    let afterExecuteDescribes = 0;
    const flaky = {
      async send(command: Parameters<typeof cf.send>[0]) {
        const name = command.constructor.name;
        if (name === "ExecuteChangeSetCommand") executed = true;
        if (executed && name === "DescribeChangeSetCommand") {
          afterExecuteDescribes++;
          if (afterExecuteDescribes === 1) throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
        }
        return cf.send(command);
      },
    };
    await expect(
      updateStackParameters({ cloudFormation: flaky, stackName: STACK, roleArn: ROLE, changes: { SlackTeamId: "T0TEAM1" }, confirm: async () => true, write: () => undefined, sleep: async () => undefined, pollMs: 1 }),
    ).rejects.toThrow("Rate exceeded");
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
});
