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
    expect(cdkDiffRisks("Resources\n[~] AWS::Lambda::Function Fn FnABC")).toEqual({ iam: false, data: [] });
  });

  it("runs cdk diff with the stack's parameters, redacting the signing key everywhere", async () => {
    const calls: Array<{ args: string[]; display: string }> = [];
    const runner: CommandRunner = { async run(_command, args, options) { calls.push({ args, display: options.display }); return { stdout: "", stderr: `diff with ${"s".repeat(43)}` }; } };
    const request: DeployRequest = { part: "control-plane", stackName: "agentx-staging-control-plane", parameters: { CallbackSigningKey: "s".repeat(43), GitHubAppId: "123" }, terminationProtection: false };
    const text = await cdkDiff({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "cognito", request });
    expect(calls[0]!.args.slice(0, 4)).toEqual(["--no-install", "cdk", "diff", "AgentXControlPlane"]);
    expect(calls[0]!.args).toContain("--no-change-set");
    expect(calls[0]!.args).toContain("agentx-staging-control-plane:GitHubAppId=123");
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
  const STATEFUL = ["AWS::DynamoDB::Table", "AWS::S3::Bucket", "AWS::Cognito::UserPool", "AWS::KMS::Key", "AWS::SecretsManager::Secret"];

  it("guards every stateful type: a table, bucket, user pool, KMS key and secret", () => {
    expect([...DATA_RESOURCE_TYPES].sort()).toEqual([...STATEFUL].sort());
  });

  it.each(STATEFUL)("stops replacing or deleting a %s under --yes, from a change set", async (type) => {
    for (const [action, replacement, verb] of [["Modify", "True", "replace"], ["Modify", "Conditional", "replace"], ["Remove", "", "delete"]] as const) {
      const reviewed = reviewChanges([change(action, "Data", type, replacement)]);
      expect(reviewed.data).toEqual([{ logicalId: "Data", type, verb }]);
      expect(await guardData({ stackName: "s", data: reviewed.data, allowReplace: new Set(), yes: true, ask: answers() })).toBe(`upgrade stopped: s would ${verb} Data (${type}) and lose its data; nothing in s changed. If you accept that, run agentx upgrade again with --allow-replace Data`);
    }
    expect(reviewChanges([change("Modify", "Data", type, "False")]).data).toEqual([]);
    expect(reviewChanges([change("Add", "Data", type, "")]).data).toEqual([]);
  });

  it.each(STATEFUL)("stops replacing or deleting a %s under --yes, from cdk diff", async (type) => {
    expect(cdkDiffRisks(`Resources\n[~] ${type} Data DataABC replace`).data).toEqual([{ logicalId: "DataABC", type, verb: "replace" }]);
    expect(cdkDiffRisks(`Resources\n[-] ${type} Data DataABC destroy`).data).toEqual([{ logicalId: "DataABC", type, verb: "delete" }]);
    expect(cdkDiffRisks(`Resources\n[+] ${type} Data DataABC`).data).toEqual([]);
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
    const text = ["Resources", "\u001b[33m[~]\u001b[39m AWS::KMS::Key Key KeyABC", " └─ [~] KeyPolicy", "[~] AWS::S3::Bucket Bucket BucketABC", " └─ [~] BucketName (requires replacement)", "[~] AWS::Lambda::Function Fn FnABC", " └─ [~] Code (may cause replacement)"].join("\n");
    expect(cdkDiffRisks(text)).toEqual({ iam: false, data: [{ logicalId: "BucketABC", type: "AWS::S3::Bucket", verb: "replace" }] });
  });

  it("never reads a cdk diff resource line it cannot understand as safe: it needs review", async () => {
    const risks = cdkDiffRisks(["Resources", "[~] AWS::DynamoDB::Table", "[?] AWS::S3::Bucket Artifacts ArtifactsABC", "[~] something new", "Outputs", "[+] Output Url: {\"Value\":\"x\"}"].join("\n"));
    expect(risks.data).toEqual([
      { logicalId: "", type: "", verb: "unclear", line: "[~] AWS::DynamoDB::Table" },
      { logicalId: "ArtifactsABC", type: "AWS::S3::Bucket", verb: "unclear", line: "[?] AWS::S3::Bucket Artifacts ArtifactsABC" },
      { logicalId: "", type: "", verb: "unclear", line: "[~] something new" },
    ]);
    const [first, second] = risks.data;
    expect(await guardData({ stackName: "s", data: [first!], allowReplace: new Set(), yes: true, ask: answers() })).toBe("upgrade stopped: agentx could not read this line of cdk diff's output for s, so it cannot tell whether it replaces or deletes data: [~] AWS::DynamoDB::Table. Nothing in s changed. Run agentx upgrade again without --yes to review the change");
    expect(await guardData({ stackName: "s", data: [second!], allowReplace: new Set(), yes: true, ask: answers() })).toContain("or with --allow-replace ArtifactsABC if you accept it");
    expect(await guardData({ stackName: "s", data: [second!], allowReplace: new Set(["ArtifactsABC"]), yes: true, ask: answers() })).toBeUndefined();
    expect(await guardData({ stackName: "s", data: [first!], allowReplace: new Set(), yes: false, ask: answers("accept") })).toBeUndefined();
    expect(await guardData({ stackName: "s", data: [first!], allowReplace: new Set(), yes: false, ask: answers("y") })).toContain("upgrade stopped: agentx could not read");
    expect(await guardData({ stackName: "s", data: [second!], allowReplace: new Set(), yes: false, ask: answers("ArtifactsABC") })).toBeUndefined();
  });
});
