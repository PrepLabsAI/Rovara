import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../../packages/cli/src/deploy/cdk-engine.js";
import { cdkDiff } from "../../packages/cli/src/deploy/cdk-engine.js";
import type { DeployRequest, StackDeployer } from "../../packages/cli/src/deploy/deployer.js";
import { cdkDiffRisks, cdkReviewedDeployer, DATA_RESOURCE_TYPES, guardData, reviewChanges, reviewLines, upgradeConfirm } from "../../packages/cli/src/upgrade/review.js";

const change = (action: string, logicalId: string, type: string, replacement = "False") => ({ action, logicalId, type, replacement });
const answers = (...replies: string[]) => { const queue = [...replies]; return async () => queue.shift() ?? ""; };

describe("reviewing an upgrade's changes (FR-042, FR-043)", () => {
  it("calls out IAM changes, and replacing or deleting a table, user pool, bucket or secret", () => {
    const reviewed = reviewChanges([
      change("Modify", "WorkerRole", "AWS::IAM::Role"),
      change("Modify", "State", "AWS::DynamoDB::Table", "True"),
      change("Remove", "Artifacts", "AWS::S3::Bucket"),
      change("Modify", "UserPool", "AWS::Cognito::UserPool", "Conditional"),
      change("Modify", "SlackSecret", "AWS::SecretsManager::Secret", "False"),
      change("Modify", "Ingress", "AWS::Lambda::Function", "True"),
    ]);
    expect(reviewed.iam.map((entry) => entry.logicalId)).toEqual(["WorkerRole"]);
    expect(reviewed.data).toEqual([
      { logicalId: "State", type: "AWS::DynamoDB::Table", verb: "replace" },
      { logicalId: "Artifacts", type: "AWS::S3::Bucket", verb: "delete" },
      { logicalId: "UserPool", type: "AWS::Cognito::UserPool", verb: "replace" },
    ]);
    expect(reviewed.other.map((entry) => entry.logicalId)).toEqual(["SlackSecret", "Ingress"]);
    expect(reviewLines("agentx-staging-control-plane", reviewed)).toEqual([
      "Changes for agentx-staging-control-plane:",
      "  IAM changes:",
      "    Modify WorkerRole (AWS::IAM::Role)",
      "  Replaces or deletes data:",
      "    replace State (AWS::DynamoDB::Table)",
      "    delete Artifacts (AWS::S3::Bucket)",
      "    replace UserPool (AWS::Cognito::UserPool)",
      "  Other changes:",
      "    Modify SlackSecret (AWS::SecretsManager::Secret)",
      "    Modify Ingress (AWS::Lambda::Function) [replacement]",
    ]);
  });

  it("stops a data replacement under --yes unless --allow-replace names it", async () => {
    const data = [{ logicalId: "State", type: "AWS::DynamoDB::Table", verb: "replace" as const }];
    expect(await guardData({ stackName: "s", data, allowReplace: new Set(), yes: true, ask: answers() })).toBe("upgrade stopped: s would replace State (AWS::DynamoDB::Table) and lose its data; nothing in s changed. If you accept that, run agentx upgrade again with --allow-replace State");
    expect(await guardData({ stackName: "s", data, allowReplace: new Set(["State"]), yes: true, ask: answers() })).toBeUndefined();
  });

  it("asks for the resource's name to be typed, and stops on anything else", async () => {
    const data = [{ logicalId: "UserPool", type: "AWS::Cognito::UserPool", verb: "replace" as const }];
    expect(await guardData({ stackName: "s", data, allowReplace: new Set(), yes: false, ask: answers("UserPool") })).toBeUndefined();
    expect(await guardData({ stackName: "s", data, allowReplace: new Set(), yes: false, ask: answers("userpool") })).toContain("upgrade stopped: s would replace UserPool");
  });

  it("confirms a change set: y applies, anything else declines with the reason kept", async () => {
    const lines: string[] = [];
    const yes = upgradeConfirm({ write: (line) => lines.push(line), ask: answers("y"), yes: false, allowReplace: new Set() });
    expect(await yes.confirm({ stackName: "s", changes: [change("Modify", "Fn", "AWS::Lambda::Function")] })).toBe(true);
    expect(lines[0]).toBe("Changes for s:");
    const no = upgradeConfirm({ write: () => undefined, ask: answers("n"), yes: false, allowReplace: new Set() });
    expect(await no.confirm({ stackName: "s", changes: [] })).toBe(false);
    expect(no.refusal()).toBe("upgrade stopped before s: nothing in it changed. Stacks upgraded before it keep the new release; run agentx upgrade again to continue");
  });
});

describe("the cdk engine's review: cdk diff (FR-042)", () => {
  const diff = [
    "Stack agentx-staging-control-plane",
    "IAM Statement Changes",
    "┌───┬──────────┐",
    "Resources",
    "[~] AWS::DynamoDB::Table State StateABC123 replace",
    " └─ [~] KeySchema (requires replacement)",
    "[-] AWS::S3::Bucket Artifacts Artifacts9F8E7D destroy",
    "[~] AWS::Lambda::Function Ingress IngressFn may be replaced",
    "[+] AWS::SecretsManager::Secret NewSecret NewSecretXYZ",
  ].join("\n");

  it("finds data replacements and deletions, and IAM changes, in cdk diff's output", () => {
    expect(cdkDiffRisks(diff)).toEqual({
      iam: true,
      data: [{ logicalId: "StateABC123", type: "AWS::DynamoDB::Table", verb: "replace" }, { logicalId: "Artifacts9F8E7D", type: "AWS::S3::Bucket", verb: "delete" }],
    });
    expect(cdkDiffRisks("Stack s\nResources\n[~] AWS::Lambda::Function Fn FnABC")).toEqual({ iam: false, data: [] });
  });

  it("reads a real cdk diff (CDK 2, --method=template): additions and changed functions are no data risk; IAM is (Task 20 live check)", () => {
    // Recorded against live15eb's control plane on 2026-09-29, trimmed to its structure.
    const real = [
      "Stack AgentXControlPlane (agentx-live15eb-control-plane) (aws://944937319445/us-east-1)",
      "IAM Statement Changes",
      "┌───┬──────────────────────────────────────┬────────┬──────────────────┐",
      "│   │ Resource                             │ Effect │ Action           │",
      "IAM Policy Changes",
      "Resources",
      "[+] AWS::SQS::Queue DeveloperTaskNotifier/NoticeQueue DeveloperTaskNotifierNoticeQueue56CA42FC",
      "[+] AWS::Lambda::Function DeveloperTaskNotifier/Function DeveloperTaskNotifierFunction551419CC",
      "[~] AWS::IAM::Policy Broker/ServiceRole/DefaultPolicy BrokerServiceRoleDefaultPolicyDDFD9E7E",
      "[~] AWS::Lambda::Function Broker BrokerE1355FD6",
      "",
      "✨  Number of stacks with differences: 1",
    ].join("\n");
    expect(cdkDiffRisks(real)).toEqual({ iam: true, data: [] });
    // The same real shape with a table deletion is caught.
    expect(cdkDiffRisks(real.replace("[+] AWS::SQS::Queue DeveloperTaskNotifier/NoticeQueue DeveloperTaskNotifierNoticeQueue56CA42FC", "[-] AWS::DynamoDB::Table State State1C20CC9A destroy")).data).toEqual([{ logicalId: "State1C20CC9A", type: "AWS::DynamoDB::Table", verb: "delete" }]);
  });

  it("runs cdk diff as a template diff, redacting the signing key everywhere", async () => {
    const calls: Array<{ args: string[]; display: string }> = [];
    const runner: CommandRunner = { async run(_command, args, options) { calls.push({ args, display: options.display }); return { stdout: "", stderr: `diff with ${"s".repeat(43)}` }; } };
    const request: DeployRequest = { part: "control-plane", stackName: "agentx-staging-control-plane", parameters: { CallbackSigningKey: "s".repeat(43), GitHubAppId: "123" }, terminationProtection: false };
    const text = await cdkDiff({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "cognito", request });
    expect(calls[0]!.args.slice(0, 4)).toEqual(["--no-install", "cdk", "diff", "AgentXControlPlane"]);
    // Controller ruling 3(b) and 3(c): CDK 2.1142 ignores --parameters for diff (and warns), and
    // --no-change-set is deprecated for --method=template.
    expect(calls[0]!.args).toContain("--method=template");
    expect(calls[0]!.args).toContain("--no-notices");
    expect(calls[0]!.args).not.toContain("--no-change-set");
    expect(calls[0]!.args).not.toContain("--parameters");
    expect(calls[0]!.display).not.toContain("s".repeat(43));
    expect(text).toBe("diff with <redacted>");
  });

  it("reviews each stack before the cdk engine deploys it, and deploys nothing after a refusal", async () => {
    const deployed: string[] = [];
    const inner: StackDeployer = { async deploy(request) { deployed.push(request.stackName); return {}; }, async outputs() { return undefined; } };
    const reviewed = cdkReviewedDeployer(inner, async (request) => { if (request.part === "control-plane") throw new Error("stopped"); });
    await reviewed.deploy({ part: "runtime", stackName: "agentx-staging-runtime", parameters: {}, terminationProtection: true });
    await expect(reviewed.deploy({ part: "control-plane", stackName: "agentx-staging-control-plane", parameters: {}, terminationProtection: false })).rejects.toThrow("stopped");
    expect(deployed).toEqual(["agentx-staging-runtime"]);
  });
});

describe("the replacement guard fails safe (FR-043)", () => {
  const STATEFUL = ["AWS::DynamoDB::Table", "AWS::S3::Bucket", "AWS::Cognito::UserPool", "AWS::KMS::Key", "AWS::SecretsManager::Secret", "AWS::SQS::Queue", "AWS::Logs::LogGroup"];
  const loses = (type: string) => (type === "AWS::Logs::LogGroup" ? ", which deletes its logs" : " and lose its data");

  it("guards every stateful type: a table, bucket, user pool, KMS key, secret, queue and log group", () => {
    expect([...DATA_RESOURCE_TYPES].sort()).toEqual([...STATEFUL].sort());
  });

  it.each(STATEFUL)("stops replacing or deleting a %s under --yes, from a change set", async (type) => {
    for (const [action, replacement, verb] of [["Modify", "True", "replace"], ["Modify", "Conditional", "replace"], ["Remove", "", "delete"]] as const) {
      const reviewed = reviewChanges([change(action, "Data", type, replacement)]);
      expect(reviewed.data).toEqual([{ logicalId: "Data", type, verb }]);
      expect(await guardData({ stackName: "s", data: reviewed.data, allowReplace: new Set(), yes: true, ask: answers() })).toBe(`upgrade stopped: s would ${verb} Data (${type})${loses(type)}; nothing in s changed. If you accept that, run agentx upgrade again with --allow-replace Data`);
    }
    expect(reviewChanges([change("Modify", "Data", type, "False")]).data).toEqual([]);
    expect(reviewChanges([change("Add", "Data", type, "")]).data).toEqual([]);
  });

  it.each(STATEFUL)("stops replacing or deleting a %s under --yes, from cdk diff", async (type) => {
    expect(cdkDiffRisks(`Stack s\nResources\n[~] ${type} Data DataABC replace\n └─ [~] Name (requires replacement)`).data).toEqual([{ logicalId: "DataABC", type, verb: "replace" }]);
    expect(cdkDiffRisks(`Stack s\nResources\n[-] ${type} Data DataABC destroy`).data).toEqual([{ logicalId: "DataABC", type, verb: "delete" }]);
    expect(cdkDiffRisks(`Stack s\nResources\n[+] ${type} Data DataABC`).data).toEqual([]);
  });

  it("treats an unrecognised Replacement value, or a Dynamic or unknown action, on a stateful resource as a replacement", () => {
    expect(reviewChanges([
      change("Modify", "A", "AWS::DynamoDB::Table", "Maybe"),
      change("Modify", "B", "AWS::S3::Bucket", ""),
      change("Dynamic", "C", "AWS::KMS::Key", "False"),
      change("Import", "D", "AWS::SecretsManager::Secret", ""),
    ]).data).toEqual([
      { logicalId: "A", type: "AWS::DynamoDB::Table", verb: "replace" },
      { logicalId: "B", type: "AWS::S3::Bucket", verb: "replace" },
      { logicalId: "C", type: "AWS::KMS::Key", verb: "replace" },
    ]);
  });

  it("reads a replacement from a stateful resource's property lines too, and ignores ANSI colours", () => {
    const text = ["Stack s", "Resources", "\u001b[33m[~]\u001b[39m AWS::KMS::Key Key KeyABC", " └─ [~] KeyPolicy", "[~] AWS::S3::Bucket Bucket BucketABC", " └─ [~] BucketName (requires replacement)", "[~] AWS::Lambda::Function Fn FnABC", " └─ [~] Code (may cause replacement)"].join("\n");
    // iam: a KMS key's KeyPolicy counts as an IAM change (controller ruling 3(e)).
    expect(cdkDiffRisks(text)).toEqual({ iam: true, data: [{ logicalId: "BucketABC", type: "AWS::S3::Bucket", verb: "replace" }] });
  });

  it("never reads a cdk diff resource line it cannot understand as safe: it needs review", async () => {
    const risks = cdkDiffRisks(["Stack s", "Resources", "[~] AWS::DynamoDB::Table", "[?] AWS::S3::Bucket Artifacts ArtifactsABC", "[~] something new", "Outputs", "[+] Output Url: {\"Value\":\"x\"}"].join("\n"));
    expect(risks.data).toEqual([
      { logicalId: "", type: "AWS::DynamoDB::Table", verb: "unclear", line: "[~] AWS::DynamoDB::Table" },
      { logicalId: "ArtifactsABC", type: "AWS::S3::Bucket", verb: "unclear", line: "[?] AWS::S3::Bucket Artifacts ArtifactsABC" },
      { logicalId: "", type: "", verb: "unclear", line: "[~] something new" },
    ]);
    const [first, second] = risks.data;
    expect(await guardData({ stackName: "s", data: [first!], allowReplace: new Set(), yes: true, ask: answers() })).toBe("upgrade stopped: agentx could not read cdk diff's output for s, so it cannot tell whether it replaces or deletes data ([~] AWS::DynamoDB::Table); nothing in s changed. Check the diff above, and run agentx upgrade again without --yes to review it");
    expect(await guardData({ stackName: "s", data: [second!], allowReplace: new Set(), yes: true, ask: answers() })).toContain("If you accept that, run agentx upgrade again with --allow-replace ArtifactsABC");
    expect(await guardData({ stackName: "s", data: [second!], allowReplace: new Set(["ArtifactsABC"]), yes: true, ask: answers() })).toBeUndefined();
    expect(await guardData({ stackName: "s", data: [first!], allowReplace: new Set(), yes: false, ask: answers("accept") })).toBeUndefined();
    expect(await guardData({ stackName: "s", data: [first!], allowReplace: new Set(), yes: false, ask: answers("y") })).toContain("upgrade stopped: agentx could not read");
    expect(await guardData({ stackName: "s", data: [second!], allowReplace: new Set(), yes: false, ask: answers("ArtifactsABC") })).toBeUndefined();
  });
});

describe("cdk diff as the real formatter prints it (review round 1)", () => {
  // Shaped like @aws-cdk/cloudformation-diff's Formatter (aws-cdk 2.1142.0): resource lines start at
  // column 0 (inside a colour reset), property lines at " ├─"/" └─", and an array or type change is a
  // JSON hunk of "[ ]", "[-]" and "[+]" lines indented under its property.
  const R = "\u001b[0m";
  const header = [`Stack ${"\u001b[1m"}AgentXControlPlane${"\u001b[22m"} (agentx-staging-control-plane)`, "\u001b[4m\u001b[1mResources\u001b[22m\u001b[24m"];
  const lambdaHunk = [
    `${R}\u001b[33m[~]\u001b[39m \u001b[36mAWS::Lambda::Function\u001b[39m Ingress/Function IngressFnABC12345${R}`,
    `${R} ├─ \u001b[33m[~]\u001b[39m Timeout${R}`,
    `${R} │   ├─ \u001b[31m[-]\u001b[39m 30${R}`,
    `${R} │   └─ \u001b[32m[+]\u001b[39m 60${R}`,
    `${R} └─ \u001b[33m[~]\u001b[39m Layers${R}`,
    `${R}     └─ \u001b[35m@@ -1,3 +1,3 @@\u001b[39m${R}`,
    `${R}        \u001b[90m[ ]\u001b[39m [${R}`,
    `${R}        \u001b[1m\u001b[31m[-]\u001b[39m \u001b[31m  "arn:aws:lambda:us-east-1:123456789012:layer:old:1"\u001b[39m\u001b[22m${R}`,
    `${R}        \u001b[1m\u001b[32m[+]\u001b[39m \u001b[32m  "arn:aws:lambda:us-east-1:123456789012:layer:new:2"\u001b[39m\u001b[22m${R}`,
    `${R}        \u001b[90m[ ]\u001b[39m ]${R}`,
  ];
  const bucketHunk = [
    `${R}[~] AWS::S3::Bucket Artifacts ArtifactsBucketABC12345${R}`,
    `${R} └─ [~] Tags${R}`,
    `${R}     └─ @@ -2,7 +2,7 @@${R}`,
    `${R}        [ ]   {${R}`,
    `${R}        [ ]     "Key": "Team",${R}`,
    `${R}        [-]     "Value": "old"${R}`,
    `${R}        [+]     "Value": "new"${R}`,
    `${R}        [ ]   }${R}`,
  ];

  it("reads a last-property array hunk under a Lambda and under a stateful resource as detail, not unclear", () => {
    expect(cdkDiffRisks([...header, ...lambdaHunk, "", "\u2728  Number of stacks with differences: 1"].join("\n"))).toEqual({ iam: false, data: [] });
    expect(cdkDiffRisks([...header, ...bucketHunk, ""].join("\n"))).toEqual({ iam: false, data: [] });
    expect(cdkDiffRisks([...header, ...lambdaHunk, ...bucketHunk, "Outputs", "[~] Output Url Url: {\"a\":1} to {\"a\":2}"].join("\n"))).toEqual({ iam: false, data: [] });
  });

  it("reads a resource line without a construct path, and a replacement under an array hunk", () => {
    const text = ["Stack s", "Resources", "[~] AWS::DynamoDB::Table StateABC replace", " └─ [~] KeySchema (requires replacement)", "     └─ @@ -1,3 +1,3 @@", "        [ ] [", "        [-]   {\"AttributeName\": \"pk\"}", "        [+]   {\"AttributeName\": \"id\"}", "        [ ] ]"].join("\n");
    expect(cdkDiffRisks(text)).toEqual({ iam: false, data: [{ logicalId: "StateABC", type: "AWS::DynamoDB::Table", verb: "replace" }] });
  });

  it("must positively find what it read: output with no Resources section and no \"There were no differences\" is unclear", () => {
    expect(cdkDiffRisks("Stack agentx-staging-runtime\nThere were no differences\n\n\u2728  Number of stacks with differences: 0")).toEqual({ iam: false, data: [] });
    // Behaviour correction (review round 2): empty output is no longer read as "no changes".
    expect(cdkDiffRisks("")).toEqual({ iam: false, data: [{ logicalId: "", type: "", verb: "unclear", line: "no \"Stack <name>\" header in cdk diff's output" }] });
    expect(cdkDiffRisks("Stack agentx-staging-runtime\nRessources\n[~] AWS::Lambda::Function Fn FnABC").data).toEqual([
      { logicalId: "", type: "", verb: "unclear", line: "no Resources section, and not \"There were no differences\"" },
    ]);
  });

  it("treats a line naming a guarded type that is not a resource line as unclear, in any section", () => {
    expect(cdkDiffRisks(["Stack s", "Resources", "[~] AWS::Lambda::Function Fn FnABC", "  [-] AWS::SQS::Queue Jobs JobsABC destroy"].join("\n")).data).toEqual([
      { logicalId: "", type: "", verb: "unclear", line: "[-] AWS::SQS::Queue Jobs JobsABC destroy" },
    ]);
    expect(cdkDiffRisks(["Stack s", "Parameters", "[~] Parameter X: AWS::Logs::LogGroup", "Resources", "[+] AWS::S3::BucketPolicy P PABC"].join("\n"))).toEqual({
      iam: true, data: [{ logicalId: "", type: "", verb: "unclear", line: "[~] Parameter X: AWS::Logs::LogGroup" }],
    });
  });

  it("treats an import ([\u2190]) as an add: nothing is lost", () => {
    expect(cdkDiffRisks("Stack s\nResources\n[\u2190] AWS::S3::Bucket Imported ImportedABC import")).toEqual({ iam: false, data: [] });
  });

  it("guards queues and log groups, with the retained flow-log group orphaned rather than deleted", async () => {
    const risks = cdkDiffRisks(["Stack s", "Resources", "[-] AWS::Logs::LogGroup VpcFlowLogs VpcFlowLogsABC orphan", "[-] AWS::Logs::LogGroup WorkerLogs WorkerLogsABC destroy", "[~] AWS::SQS::Queue Jobs JobsABC replace", " └─ [~] FifoQueue (requires replacement)"].join("\n"));
    expect(risks.data).toEqual([
      { logicalId: "VpcFlowLogsABC", type: "AWS::Logs::LogGroup", verb: "orphan" },
      { logicalId: "WorkerLogsABC", type: "AWS::Logs::LogGroup", verb: "delete" },
      { logicalId: "JobsABC", type: "AWS::SQS::Queue", verb: "replace" },
    ]);
    // Controller ruling 3(d): one refusal names every unaccepted change.
    expect(await guardData({ stackName: "s", data: risks.data, allowReplace: new Set(), yes: true, ask: answers() })).toBe(
      "upgrade stopped: s would remove VpcFlowLogsABC (AWS::Logs::LogGroup) from the stack, which orphans the retained log group, delete WorkerLogsABC (AWS::Logs::LogGroup), which deletes its logs, and replace JobsABC (AWS::SQS::Queue) and lose its data; nothing in s changed. If you accept that, run agentx upgrade again with --allow-replace VpcFlowLogsABC --allow-replace WorkerLogsABC --allow-replace JobsABC",
    );
    expect(await guardData({ stackName: "s", data: risks.data, allowReplace: new Set(["WorkerLogsABC"]), yes: false, ask: answers("VpcFlowLogsABC", "no") })).toBe(
      "upgrade stopped: s would replace JobsABC (AWS::SQS::Queue) and lose its data; nothing in s changed. If you accept that, run agentx upgrade again with --allow-replace JobsABC --allow-replace VpcFlowLogsABC --allow-replace WorkerLogsABC (VpcFlowLogsABC and WorkerLogsABC are changes you already accepted; --yes needs them named too)",
    );
  });

  it("counts resource policies, and a KMS key's KeyPolicy, as IAM changes", () => {
    for (const type of ["AWS::S3::BucketPolicy", "AWS::Lambda::Permission", "AWS::SQS::QueuePolicy", "AWS::SNS::TopicPolicy", "AWS::SecretsManager::ResourcePolicy"]) {
      expect(cdkDiffRisks(`Stack s\nResources\n[~] ${type} P PABC`)).toEqual({ iam: true, data: [] });
      expect(reviewChanges([change("Modify", "P", type)]).iam.map((entry) => entry.logicalId)).toEqual(["P"]);
    }
    expect(cdkDiffRisks("Stack s\nResources\n[~] AWS::KMS::Key Key KeyABC\n └─ [~] KeyPolicy\n     └─ [~] .Statement:")).toEqual({ iam: true, data: [] });
    expect(cdkDiffRisks("Stack s\nResources\n[~] AWS::KMS::Key Key KeyABC\n └─ [~] Description")).toEqual({ iam: false, data: [] });
    // A change set does not say which property changed, so any KMS key modification is shown with the IAM changes.
    expect(reviewChanges([change("Modify", "Key", "AWS::KMS::Key", "False")]).iam.map((entry) => entry.logicalId)).toEqual(["Key"]);
  });
});

describe("cdk diff must show it was read (review round 2)", () => {
  const NO_HEADER = { logicalId: "", type: "", verb: "unclear", line: "no \"Stack <name>\" header in cdk diff's output" };
  const NO_RESOURCES = { logicalId: "", type: "", verb: "unclear", line: "no Resources section, and not \"There were no differences\"" };

  it("reads a diff of only Outputs, or only Metadata and the template's Description, as safe", () => {
    expect(cdkDiffRisks("Stack s\nOutputs\n[~] Output ApiUrl ApiUrl: {\"Value\":\"a\"} to {\"Value\":\"b\"}\n[+] Output Extra: x\n")).toEqual({ iam: false, data: [] });
    expect(cdkDiffRisks("Stack s\nTemplate\n[~] Description Description: old to new\n\nMetadata\n[+] Metadata Info Info: x\n")).toEqual({ iam: false, data: [] });
  });

  it("reads any other diff without a Resources section as unclear", () => {
    expect(cdkDiffRisks("Stack s\nConditions\n[~] Condition IsProd IsProd: {} to {}\n").data).toEqual([NO_RESOURCES]);
    for (const heading of ["Parameters", "Mappings", "Other Changes", "IAM Statement Changes", "Security Group Changes"]) {
      expect(cdkDiffRisks(`Stack s\n${heading}\n`).data).toEqual([NO_RESOURCES]);
    }
    expect(cdkDiffRisks("Stack s\nTemplate\n[~] Transform Transform: a to b\n").data).toEqual([NO_RESOURCES]);
    expect(cdkDiffRisks("Stack s\n").data).toEqual([NO_RESOURCES]);
    expect(cdkDiffRisks("Stack s\nOutputs\n[~] Something else entirely\n").data).toEqual([{ logicalId: "", type: "", verb: "unclear", line: "[~] Something else entirely" }, NO_RESOURCES]);
  });

  it("needs a Stack header: a headerless \"There were no differences\" or Resources section is unclear", () => {
    expect(cdkDiffRisks("There were no differences").data).toEqual([NO_HEADER]);
    expect(cdkDiffRisks("Resources\n[~] AWS::Lambda::Function Fn FnABC").data).toEqual([NO_HEADER]);
    expect(cdkDiffRisks("Stack s\n  There were no differences").data).toEqual([NO_RESOURCES]);
  });

  it("reads a replaced resource with no property lines (a type change) as unclear", () => {
    expect(cdkDiffRisks("Stack s\nResources\n[~] AWS::Lambda::Function Fn FnABC replace\n[+] AWS::SNS::Topic T TABC").data).toEqual([
      { logicalId: "FnABC", type: "AWS::Lambda::Function", verb: "unclear", line: "[~] AWS::Lambda::Function Fn FnABC replace" },
    ]);
    expect(cdkDiffRisks("Stack s\nResources\n[~] AWS::DynamoDB::Table State StateABC replace").data).toEqual([
      { logicalId: "StateABC", type: "AWS::DynamoDB::Table", verb: "unclear", line: "[~] AWS::DynamoDB::Table State StateABC replace" },
    ]);
  });
});
