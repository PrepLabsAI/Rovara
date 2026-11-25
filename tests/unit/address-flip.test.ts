import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  FlipRefused,
  awsCliCloudFormation,
  flipAddress,
  flipChangeSetProblems,
  parseFlipArguments,
  type Change,
  type FlipCloudFormation,
} from "../../scripts/address-flip.js";

// The change-set JSON fixtures are in DescribeChangeSet's output shape, the same shape as the recorded ones in tests/fixtures/test-deploy. They were written by hand to that shape (this
// lane makes no AWS calls): the first real change set from the scratch-stack proof of the flip (does the mapping's ApiId update in place?) should replace modify-apimapping-in-place.json and,
// if it is a replacement, replace-apimapping.json, so the guard is checked against what CloudFormation really returns.
const fixture = (name: string): { Status: string; StatusReason?: string; Parameters: unknown; Changes: Change[] } =>
  JSON.parse(readFileSync(new URL(`../fixtures/address-flip/${name}.json`, import.meta.url), "utf8")) as never;

const OLD = "abcde12345";
const NEW = "fghij67890";
const STACK = "AgentXApiAddress";

type Command = { constructor: { name: string }; input: Record<string, unknown> };

interface FakeOptions {
  fixtureName: string;
  stackStatus?: string;
  parameters?: Array<{ ParameterKey: string; ParameterValue: string }>;
  outputs?: Array<{ OutputKey: string; OutputValue: string }>;
  /** What the stack looks like after ExecuteChangeSet. */
  finalStatus?: string;
  finalMappedApiId?: string;
  pages?: Change[][];
  /** After ExecuteChangeSet, this many reads still show the pre-execute state (CloudFormation lags for a moment). */
  staleReadsAfterExecute?: number;
  /** DeleteChangeSet fails. */
  deleteFails?: boolean;
  /** The change set never settles. */
  neverSettles?: boolean;
}

/** A CloudFormation that answers from a recorded change set; it records every call. */
function fakeCloudFormation(options: FakeOptions) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  let executed = false;
  let stale = 0;
  const recorded = fixture(options.fixtureName);
  const parameters = options.parameters ?? [{ ParameterKey: "ApiId", ParameterValue: OLD }];
  const outputs = options.outputs ?? [{ OutputKey: "PublicApiOrigin", OutputValue: "https://api.beta.example.com" }, { OutputKey: "MappedApiId", OutputValue: OLD }];
  const client: FlipCloudFormation = {
    async send(raw: unknown): Promise<unknown> {
      const command = raw as Command;
      calls.push({ name: command.constructor.name, input: command.input });
      if (raw instanceof DescribeStacksCommand) {
        const showsExecuted = executed && stale <= 0;
        if (executed && stale > 0) stale -= 1;
        const settled = showsExecuted ? options.finalStatus ?? "UPDATE_COMPLETE" : options.stackStatus ?? "UPDATE_COMPLETE";
        const mapped = showsExecuted ? (options.finalMappedApiId ?? NEW) : OLD;
        return { Stacks: [{ StackName: STACK, StackStatus: settled, Parameters: parameters, Outputs: outputs.map((o) => (o.OutputKey === "MappedApiId" ? { ...o, OutputValue: mapped } : o)) }] };
      }
      if (raw instanceof CreateChangeSetCommand) return { Id: `arn:aws:cloudformation:us-east-1:123456789012:changeSet/${String(command.input.ChangeSetName)}/1` };
      if (raw instanceof DescribeChangeSetCommand) {
        if (options.neverSettles === true) return { Status: "CREATE_PENDING", Changes: [] };
        const token = command.input.NextToken as string | undefined;
        if (options.pages !== undefined) {
          const index = token === undefined ? 0 : Number(token);
          return { ...recorded, Changes: options.pages[index], NextToken: index + 1 < options.pages.length ? String(index + 1) : undefined };
        }
        if (executed && stale > 0) { stale -= 1; return recorded; }
        return executed ? { ...recorded, ExecutionStatus: (options.finalStatus ?? "UPDATE_COMPLETE") === "UPDATE_COMPLETE" ? "EXECUTE_COMPLETE" : "EXECUTE_FAILED" } : recorded;
      }
      if (raw instanceof ExecuteChangeSetCommand) { executed = true; stale = options.staleReadsAfterExecute ?? 0; return {}; }
      if (raw instanceof DeleteChangeSetCommand) { if (options.deleteFails === true) throw new Error("AccessDenied on DeleteChangeSet"); return {}; }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  };
  return { client, calls, names: () => calls.map((call) => call.name) };
}

const run = (fake: ReturnType<typeof fakeCloudFormation>, input: { apiId?: string; execute?: boolean; env?: string | undefined; stackName?: string; maxPolls?: number } = {}) =>
  flipAddress({ cloudFormation: fake.client, sleep: async () => undefined, now: () => 1, ...(input.maxPolls === undefined ? {} : { maxPolls: input.maxPolls }) }, {
    env: input.env, apiId: input.apiId ?? NEW, ...(input.stackName === undefined ? {} : { stackName: input.stackName }), ...(input.execute === undefined ? {} : { execute: input.execute }),
  });

describe("the flip guard on recorded change sets", () => {
  it("accepts exactly one in-place Modify of the ApiMapping, caused by ApiId alone", () => {
    expect(flipChangeSetProblems(fixture("modify-apimapping-in-place").Changes)).toEqual([]);
  });

  it.each([
    ["a replacement", "replace-apimapping", /not an in-place update \(Replacement True\)/u],
    ["a possible replacement", "conditional-replacement-apimapping", /not an in-place update \(Replacement Conditional\)/u],
    ["a Modify plus another change", "modify-apimapping-and-add-alarm", /2 changes, not exactly one/u],
    ["two ApiMapping Modifies", "two-apimapping-modifies", /2 changes, not exactly one/u],
    ["a Remove and an Add of the mapping (a replacement by another route)", "remove-and-add-apimapping", /2 changes, not exactly one/u],
    ["a Modify of another resource", "modify-domain-name", /not AWS::ApiGatewayV2::ApiMapping/u],
    ["a change to another property", "modify-apimapping-stage", /not the ApiId property/u],
    ["ApiId plus another property", "modify-apimapping-apiid-and-stage", /not the ApiId property/u],
    ["a Modify that does not say which property", "modify-apimapping-no-details", /does not say which property/u],
    ["a change beyond Properties", "modify-apimapping-and-tags-scope", /not Properties alone/u],
    ["no changes", "no-changes", /0 changes.*nothing would change/u],
  ])("refuses %s", (_what, name, reason) => {
    const problems = flipChangeSetProblems(fixture(name).Changes);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(reason);
  });

  it("refuses a Modify that is an Add or a Remove in the one change", () => {
    const [change] = fixture("modify-apimapping-in-place").Changes;
    for (const action of ["Add", "Remove", "Import", "Dynamic"] as const) {
      const changed: Change = { ...change!, ResourceChange: { ...change!.ResourceChange, Action: action } };
      expect(flipChangeSetProblems([changed]).join(), action).toMatch(/not a Modify/u);
    }
  });

  it("refuses a change that is not a resource change", () => {
    expect(flipChangeSetProblems([{ Type: "Resource" }]).join()).toMatch(/not a resource change/u);
  });
});

describe("the flip", () => {
  it("creates a change set with the new ApiId from the previous template, checks it, and leaves it unexecuted", async () => {
    const fake = fakeCloudFormation({ fixtureName: "modify-apimapping-in-place" });
    const result = await run(fake);
    expect(result).toMatchObject({ stackName: STACK, previousApiId: OLD, apiId: NEW, mappingLogicalId: "Mapping", executed: false, changeSetName: `address-flip-${NEW}-1` });
    expect(fake.names()).toEqual(["DescribeStacksCommand", "CreateChangeSetCommand", "DescribeChangeSetCommand"]);
    const create = fake.calls[1]!.input;
    expect(create).toMatchObject({ StackName: STACK, ChangeSetType: "UPDATE", UsePreviousTemplate: true, Parameters: [{ ParameterKey: "ApiId", ParameterValue: NEW }] });
    // No capabilities are passed: a template that needs IAM refuses to create.
    expect(create).not.toHaveProperty("Capabilities");
    expect(create).not.toHaveProperty("TemplateBody");
  });

  it("keeps every other parameter by UsePreviousValue", async () => {
    const fake = fakeCloudFormation({ fixtureName: "modify-apimapping-in-place", parameters: [{ ParameterKey: "ApiId", ParameterValue: OLD }, { ParameterKey: "Other", ParameterValue: "x" }] });
    await run(fake);
    expect(fake.calls[1]!.input.Parameters).toEqual([{ ParameterKey: "ApiId", ParameterValue: NEW }, { ParameterKey: "Other", UsePreviousValue: true }]);
  });

  it("executes a passing change set only when asked, and confirms the mapped API", async () => {
    const fake = fakeCloudFormation({ fixtureName: "modify-apimapping-in-place" });
    const result = await run(fake, { execute: true });
    expect(result.executed).toBe(true);
    expect(fake.names()).toContain("ExecuteChangeSetCommand");
    expect(fake.names().indexOf("ExecuteChangeSetCommand")).toBeGreaterThan(fake.names().indexOf("DescribeChangeSetCommand"));
  });

  it.each([
    ["a replacement", "replace-apimapping"],
    ["a second change", "modify-apimapping-and-add-alarm"],
    ["a remove and add", "remove-and-add-apimapping"],
    ["another resource", "modify-domain-name"],
    ["another property", "modify-apimapping-stage"],
  ])("refuses %s, deletes the change set and never executes (even with execute)", async (_what, name) => {
    const fake = fakeCloudFormation({ fixtureName: name });
    await expect(run(fake, { execute: true })).rejects.toBeInstanceOf(FlipRefused);
    expect(fake.names()).toContain("DeleteChangeSetCommand");
    expect(fake.names()).not.toContain("ExecuteChangeSetCommand");
  });

  it("refuses a change set whose ApiId parameter is not the requested one", async () => {
    const fake = fakeCloudFormation({ fixtureName: "modify-apimapping-wrong-parameter" });
    await expect(run(fake)).rejects.toThrow(/change set's ApiId is zzzzz00000, not fghij67890/u);
    expect(fake.names()).toContain("DeleteChangeSetCommand");
  });

  it("refuses a change set CloudFormation could not create (for example, no changes)", async () => {
    const fake = fakeCloudFormation({ fixtureName: "no-changes" });
    await expect(run(fake, { execute: true })).rejects.toThrow(/could not be created: The submitted information didn't contain changes/u);
    expect(fake.names()).toContain("DeleteChangeSetCommand");
    expect(fake.names()).not.toContain("ExecuteChangeSetCommand");
  });

  it("reads every page of the change set: a single change on page one and a second on page two is refused", async () => {
    const [mapping] = fixture("modify-apimapping-in-place").Changes;
    const [alarm] = fixture("modify-apimapping-and-add-alarm").Changes.slice(1);
    const split = fakeCloudFormation({ fixtureName: "modify-apimapping-in-place", pages: [[mapping!], [alarm!]] });
    await expect(run(split)).rejects.toThrow(/2 changes, not exactly one/u);
    const single = fakeCloudFormation({ fixtureName: "modify-apimapping-in-place", pages: [[mapping!]] });
    await expect(run(single)).resolves.toMatchObject({ executed: false });
  });

  it("does not start from a stack that is mid-operation, stuck, not an address stack, or already pointing there", async () => {
    await expect(run(fakeCloudFormation({ fixtureName: "modify-apimapping-in-place", stackStatus: "UPDATE_IN_PROGRESS" }))).rejects.toThrow(/UPDATE_IN_PROGRESS, not one a flip can start from/u);
    await expect(run(fakeCloudFormation({ fixtureName: "modify-apimapping-in-place", stackStatus: "UPDATE_ROLLBACK_FAILED" }))).rejects.toThrow(/not one a flip can start from/u);
    await expect(run(fakeCloudFormation({ fixtureName: "modify-apimapping-in-place", outputs: [] }))).rejects.toThrow(/is not an address stack/u);
    await expect(run(fakeCloudFormation({ fixtureName: "modify-apimapping-in-place", parameters: [{ ParameterKey: "Other", ParameterValue: "x" }] }))).rejects.toThrow(/is not an address stack/u);
    const same = fakeCloudFormation({ fixtureName: "modify-apimapping-in-place" });
    await expect(run(same, { apiId: OLD })).rejects.toThrow(/already points at abcde12345/u);
    // None of these created anything.
    expect(same.names()).not.toContain("CreateChangeSetCommand");
  });

  it.each(["", "ABCDE12345", "abcde1234", "abcde123456", "abcde-1234", "https://abcde12345.example.com"])("refuses the API id %j before any call", async (apiId) => {
    const fake = fakeCloudFormation({ fixtureName: "modify-apimapping-in-place" });
    await expect(run(fake, { apiId })).rejects.toThrow(/is not an HTTP API id/u);
    expect(fake.calls).toEqual([]);
  });

  it("reports a rolled-back execution as not flipped, and a stack whose mapped API is not the new one", async () => {
    await expect(run(fakeCloudFormation({ fixtureName: "modify-apimapping-in-place", finalStatus: "UPDATE_ROLLBACK_COMPLETE" }), { execute: true })).rejects.toThrow(/rolled back: the address still points at the previous API/u);
    await expect(run(fakeCloudFormation({ fixtureName: "modify-apimapping-in-place", finalMappedApiId: OLD }), { execute: true })).rejects.toThrow(/MappedApiId output is abcde12345, not fghij67890/u);
  });

  it("refuses an invalid change set name", async () => {
    const fake = fakeCloudFormation({ fixtureName: "modify-apimapping-in-place" });
    await expect(flipAddress({ cloudFormation: fake.client, sleep: async () => undefined }, { env: undefined, apiId: NEW, changeSetName: "1 bad name" })).rejects.toThrow(/not a valid change set name/u);
  });
});

describe("the flip's command line", () => {
  it("takes the environment (or --legacy) and the API id, and the optional stack check, region, profile, name and --execute", () => {
    expect(parseFlipArguments(["--env", "beta", "--api-id", NEW])).toEqual({ env: "beta", stackName: undefined, apiId: NEW, region: undefined, profile: undefined, changeSetName: undefined, execute: false });
    expect(parseFlipArguments(["--legacy", "--api-id", NEW, "--stack", STACK, "--region", "us-west-2", "--profile", "p", "--change-set-name", "n", "--execute"])).toEqual({ env: undefined, stackName: STACK, apiId: NEW, region: "us-west-2", profile: "p", changeSetName: "n", execute: true });
  });

  it("refuses a missing API id, neither or both of --env and --legacy, an unknown flag, and a flag with no value", () => {
    expect(() => parseFlipArguments(["--env", "beta"])).toThrow(/usage:/u);
    expect(() => parseFlipArguments(["--api-id", NEW])).toThrow(/usage:/u);
    expect(() => parseFlipArguments(["--env", "beta", "--legacy", "--api-id", NEW])).toThrow(/usage:/u);
    expect(() => parseFlipArguments(["--env", "beta", "--api-id", NEW, "--force"])).toThrow(/unknown argument --force/u);
    expect(() => parseFlipArguments(["--env", "beta", "--api-id"])).toThrow(/--api-id needs a value/u);
  });
});

describe("the flip derives the stack from the environment", () => {
  it("uses AgentXApiAddress for the legacy install and agentx-<env>-address for a named one", async () => {
    const legacy = fakeCloudFormation({ fixtureName: "modify-apimapping-in-place" });
    await expect(run(legacy)).resolves.toMatchObject({ stackName: "AgentXApiAddress" });
    expect(legacy.calls.every((call) => call.input.StackName === "AgentXApiAddress")).toBe(true);
    const named = fakeCloudFormation({ fixtureName: "modify-apimapping-in-place" });
    await expect(run(named, { env: "beta" })).resolves.toMatchObject({ stackName: "agentx-beta-address" });
    expect(named.calls.every((call) => call.input.StackName === "agentx-beta-address")).toBe(true);
  });

  it("refuses a free-form stack name unless it is the derived one, before any call", async () => {
    for (const [env, stackName] of [[undefined, "agentx-prod-address"], ["beta", "agentx-prod-address"], ["beta", "AgentXApiAddress"], ["beta", "agentx-beta-control-plane"]] as const) {
      const fake = fakeCloudFormation({ fixtureName: "modify-apimapping-in-place" });
      await expect(run(fake, { env, stackName })).rejects.toThrow(/is not the address stack of .*derived from the environment/u);
      expect(fake.calls, `${String(env)} ${stackName}`).toEqual([]);
    }
    const fake = fakeCloudFormation({ fixtureName: "modify-apimapping-in-place" });
    await expect(run(fake, { env: "beta", stackName: "agentx-beta-address" })).resolves.toMatchObject({ stackName: "agentx-beta-address" });
  });

  it("refuses an invalid environment name before any call", async () => {
    for (const env of ["", "Beta", "beta-", "a--b", "x".repeat(21)]) {
      const fake = fakeCloudFormation({ fixtureName: "modify-apimapping-in-place" });
      await expect(run(fake, { env })).rejects.toThrow(/is not a valid environment name/u);
      expect(fake.calls).toEqual([]);
    }
  });
});

describe("the flip's waits and clean-up", () => {
  it("does not judge the stack until the change set has finished executing (no false failure from a stale read)", async () => {
    const fake = fakeCloudFormation({ fixtureName: "modify-apimapping-in-place", staleReadsAfterExecute: 3 });
    await expect(run(fake, { execute: true })).resolves.toMatchObject({ executed: true });
  });

  it("does not report a false rollback from a stale read after a real rollback either: the outcome is the final one", async () => {
    const fake = fakeCloudFormation({ fixtureName: "modify-apimapping-in-place", staleReadsAfterExecute: 2, finalStatus: "UPDATE_ROLLBACK_COMPLETE" });
    await expect(run(fake, { execute: true })).rejects.toThrow(/rolled back: the address still points at the previous API/u);
  });

  it("deletes a change set that never settles, and never executes it", async () => {
    const fake = fakeCloudFormation({ fixtureName: "modify-apimapping-in-place", neverSettles: true });
    await expect(run(fake, { execute: true, maxPolls: 3 })).rejects.toThrow(/gave up waiting for change set.*the change set was deleted/su);
    expect(fake.names()).toContain("DeleteChangeSetCommand");
    expect(fake.names()).not.toContain("ExecuteChangeSetCommand");
  });

  it("says so when it cannot delete a change set that never settled", async () => {
    const fake = fakeCloudFormation({ fixtureName: "modify-apimapping-in-place", neverSettles: true, deleteFails: true });
    await expect(run(fake, { maxPolls: 2 })).rejects.toThrow(/gave up waiting.*could not be deleted \(AccessDenied on DeleteChangeSet\).*delete it by hand/su);
  });

  it("reports BOTH the refusal and a failed delete, and still never executes", async () => {
    const fake = fakeCloudFormation({ fixtureName: "replace-apimapping", deleteFails: true });
    const error = await run(fake, { execute: true }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FlipRefused);
    const message = (error as FlipRefused).message;
    expect(message).toMatch(/not an in-place update \(Replacement True\)/u);
    expect(message).toMatch(/could not be deleted \(AccessDenied on DeleteChangeSet\).*NOT executed, delete it by hand/u);
    expect(fake.names()).not.toContain("ExecuteChangeSetCommand");
  });

  it("reports both for a FAILED change set too", async () => {
    const fake = fakeCloudFormation({ fixtureName: "no-changes", deleteFails: true });
    await expect(run(fake)).rejects.toThrow(/could not be created: The submitted information.*could not be deleted/su);
  });
});

describe("the aws CLI adapter (the public repository does not import the CloudFormation SDK)", () => {
  const recorder = (stdout: string | ((args: readonly string[]) => string) = "{}") => {
    const calls: Array<{ file: string; args: readonly string[]; environment: NodeJS.ProcessEnv }> = [];
    const run = (file: string, args: readonly string[], environment: NodeJS.ProcessEnv): string => {
      calls.push({ file, args, environment });
      return typeof stdout === "string" ? stdout : stdout(args);
    };
    return { calls, run };
  };

  it("runs one attempt per call, with no pager, JSON output, the region and the profile, and no shell", async () => {
    const fake = recorder('{"Stacks":[{"StackName":"s"}]}');
    const port = awsCliCloudFormation({ region: "us-west-2", profile: "p", run: fake.run });
    await expect(port.send(new DescribeStacksCommand({ StackName: "AgentXApiAddress" }))).resolves.toEqual({ Stacks: [{ StackName: "s" }] });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.file).toBe("aws");
    expect(fake.calls[0]!.args).toEqual(["cloudformation", "describe-stacks", "--stack-name", "AgentXApiAddress", "--output", "json", "--no-cli-pager", "--region", "us-west-2", "--profile", "p"]);
    expect(fake.calls[0]!.environment).toMatchObject({ AWS_MAX_ATTEMPTS: "1", AWS_PAGER: "" });
  });

  it("builds each call's arguments from its input", async () => {
    const fake = recorder();
    const port = awsCliCloudFormation({ run: fake.run });
    await port.send(new CreateChangeSetCommand({
      StackName: "AgentXApiAddress", ChangeSetName: "cs", ChangeSetType: "UPDATE", UsePreviousTemplate: true, Description: "d",
      Parameters: [{ ParameterKey: "ApiId", ParameterValue: NEW }, { ParameterKey: "Other", UsePreviousValue: true }],
    }));
    await port.send(new DescribeChangeSetCommand({ StackName: "AgentXApiAddress", ChangeSetName: "cs" }));
    await port.send(new ExecuteChangeSetCommand({ StackName: "AgentXApiAddress", ChangeSetName: "cs" }));
    await port.send(new DeleteChangeSetCommand({ StackName: "AgentXApiAddress", ChangeSetName: "cs" }));
    const [create, describe, execute, remove] = fake.calls.map((call) => call.args.slice(0, call.args.indexOf("--output")));
    expect(create).toEqual(["cloudformation", "create-change-set", "--stack-name", "AgentXApiAddress", "--change-set-name", "cs", "--change-set-type", "UPDATE", "--use-previous-template", "--description", "d", "--parameters", `ParameterKey=ApiId,ParameterValue=${NEW}`, "ParameterKey=Other,UsePreviousValue=true"]);
    expect(describe).toEqual(["cloudformation", "describe-change-set", "--stack-name", "AgentXApiAddress", "--change-set-name", "cs"]);
    expect(execute).toEqual(["cloudformation", "execute-change-set", "--stack-name", "AgentXApiAddress", "--change-set-name", "cs"]);
    expect(remove).toEqual(["cloudformation", "delete-change-set", "--stack-name", "AgentXApiAddress", "--change-set-name", "cs"]);
    // No Capabilities flag is ever passed.
    expect(fake.calls.flatMap((call) => call.args)).not.toContain("--capabilities");
  });

  it("treats empty output as an empty document, and passes a failing call's error through", async () => {
    await expect(awsCliCloudFormation({ run: recorder("").run }).send(new ExecuteChangeSetCommand({ StackName: "s", ChangeSetName: "c" }))).resolves.toEqual({});
    const failing = awsCliCloudFormation({ run: () => { throw new Error("aws cloudformation describe-stacks failed: Stack does not exist"); } });
    await expect(failing.send(new DescribeStacksCommand({ StackName: "s" }))).rejects.toThrow(/Stack does not exist/u);
  });

  it("drives a whole flip through the adapter's argument builder", async () => {
    const recorded = fixture("modify-apimapping-in-place");
    const stack = { Stacks: [{ StackName: STACK, StackStatus: "UPDATE_COMPLETE", Parameters: [{ ParameterKey: "ApiId", ParameterValue: OLD }], Outputs: [{ OutputKey: "PublicApiOrigin", OutputValue: "https://api.example.com" }] }] };
    const fake = recorder((args) => JSON.stringify(args[1] === "describe-stacks" ? stack : args[1] === "create-change-set" ? { Id: "id" } : args[1] === "describe-change-set" ? recorded : {}));
    const result = await flipAddress({ cloudFormation: awsCliCloudFormation({ region: "us-east-1", run: fake.run }), sleep: async () => undefined, now: () => 1 }, { env: undefined, apiId: NEW });
    expect(result).toMatchObject({ executed: false, previousApiId: OLD, apiId: NEW });
    expect(fake.calls.map((call) => call.args[1])).toEqual(["describe-stacks", "create-change-set", "describe-change-set"]);
  });

  it("the script imports no AWS SDK", () => {
    const source = readFileSync(new URL("../../scripts/address-flip.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/@aws-sdk|aws-cdk-lib/u);
  });
});
