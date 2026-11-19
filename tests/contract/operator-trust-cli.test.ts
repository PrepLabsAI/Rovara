// L4-HARD (b): the CLI side of the operator-role trust rules. `agentx init` (flags), the bundle answers, the stored answers and upgrade all refuse a whole-account principal and a
// principal of another account with no external id, with words that say what to change; an upgrade of an old access stack carries the external id and refuses a stored bad pair
// BEFORE any stack is touched. (The template side is tests/contract/access-operator-trust.test.ts.)
import { describe, expect, it } from "vitest";
import { BundleAnswersSchema } from "../../packages/cli/src/deploy/export-bundle.js";
import { collectInitAnswers, type InitFlags } from "../../packages/cli/src/init/answers.js";
import { InitAnswersSchema } from "../../packages/cli/src/init/install-state.js";
import { upgradeAnswers } from "../../packages/cli/src/upgrade/answers.js";
import type { StackDescription } from "../../packages/cli/src/environments/adopt.js";
import { scriptedPrompter, settingsScript } from "../support/init-fakes.js";
import { SETTINGS } from "../support/doctor-fakes.js";

const ACCOUNT = "123456789012";
const OTHER = "210987654321";
const SAME = `arn:aws:iam::${ACCOUNT}:role/platform`;
const OUTSIDE = `arn:aws:iam::${OTHER}:role/outside`;
const EXT = "ext-4f9c2a7e";
const KEY_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf";

const base = { env: "staging", region: "us-east-1", account: ACCOUNT, releaseVersion: "1.2.3", processEnv: {}, now: () => Date.parse("2026-09-27T00:00:00.000Z") };
const flags: InitFlags = {
  engine: "templates", identity: "cognito",
  orchestratorModel: "us.anthropic.claude-sonnet-4-6", classifierModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0", workerModel: "us.anthropic.claude-sonnet-4-6",
  permissionBoundary: "", operatorPrincipal: "", alertEmail: "ops@example.com", budget: "0",
  githubAccount: "acme", githubAccountType: "organization", githubAppName: "AgentX acme (staging)", slackAppName: "AgentX acme (staging)", slackAppPostedMessages: "accept",
};
const collect = (extra: Partial<InitFlags>) => collectInitAnswers({ ...base, flags: { ...flags, ...extra }, prompter: scriptedPrompter(settingsScript({ flags: { ...flags, ...extra } })) });

describe("agentx init flags", () => {
  it("keeps the default and accepts a same-account role, and another account's role with its external id", async () => {
    expect((await collect({})).answers).not.toHaveProperty("operatorPrincipalArn");
    expect((await collect({ operatorPrincipal: SAME })).answers).toMatchObject({ operatorPrincipalArn: SAME });
    const outside = (await collect({ operatorPrincipal: OUTSIDE, operatorExternalId: EXT })).answers;
    expect(outside).toMatchObject({ operatorPrincipalArn: OUTSIDE, operatorExternalId: EXT });
    expect(InitAnswersSchema.safeParse(outside).success).toBe(true);
  });
  it("refuses a whole account, another account's principal without an id, and an id alone, before anything is asked or deployed", async () => {
    await expect(collect({ operatorPrincipal: `arn:aws:iam::${ACCOUNT}:root` })).rejects.toThrow(/whole account \(:root\)/u);
    await expect(collect({ operatorPrincipal: `arn:aws:iam::${OTHER}:root`, operatorExternalId: EXT })).rejects.toThrow(/whole account \(:root\)/u);
    await expect(collect({ operatorPrincipal: OUTSIDE })).rejects.toThrow(/another AWS account \(210987654321\).*--operator-external-id/u);
    await expect(collect({ operatorExternalId: EXT })).rejects.toThrow(/only used with an operator principal/u);
    await expect(collect({ operatorPrincipal: OUTSIDE, operatorExternalId: "x" })).rejects.toThrow(/2 to 1224 characters/u);
  });
});

describe("stored and bundle answers: the same shapes", () => {
  const bundle = { schemaVersion: 1, env: "staging", region: "us-east-1", account: ACCOUNT, engine: "templates", releaseVersion: "1.2.3", identity: { mode: "cognito" }, models: SETTINGS.models };
  it("accepts a role or user and an id; refuses :root, sts ARNs and a bad id (no `sts` principals any more)", () => {
    expect(BundleAnswersSchema.safeParse({ ...bundle, operatorPrincipalArn: SAME, operatorExternalId: EXT }).success).toBe(true);
    expect(BundleAnswersSchema.safeParse({ ...bundle, operatorPrincipalArn: `arn:aws:iam::${ACCOUNT}:user/ops` }).success).toBe(true);
    for (const bad of [`arn:aws:iam::${ACCOUNT}:root`, `arn:aws:sts::${ACCOUNT}:assumed-role/a/b`, "*"]) expect(BundleAnswersSchema.safeParse({ ...bundle, operatorPrincipalArn: bad }).success, bad).toBe(false);
    expect(BundleAnswersSchema.safeParse({ ...bundle, operatorPrincipalArn: SAME, operatorExternalId: "bad id" }).success).toBe(false);
  });
});

describe("upgrade: an access stack deployed before these rules", () => {
  const stacks = (access: Record<string, string>) => ({
    async describe(name: string): Promise<StackDescription | undefined> {
      const parameters = name.endsWith("-access") ? access : { GitHubAppId: "123", GitHubAppPrivateKeySecretArn: KEY_ARN, GitHubAppCredentialRef: "github-agentx-sdlc", CallbackSigningKey: "****", AdminClaim: "cognito:groups", AdminValues: "[\"agentx-admin\"]" };
      return { status: "UPDATE_COMPLETE", outputs: {}, parameters };
    },
  });
  it("carries the deployed external id with its principal, so an upgrade never drops it", async () => {
    const answers = await upgradeAnswers({ settings: SETTINGS, stacks: stacks({ OperatorPrincipalArn: OUTSIDE, OperatorExternalId: EXT }) });
    expect(answers).toMatchObject({ operatorPrincipalArn: OUTSIDE, operatorExternalId: EXT });
    const same = await upgradeAnswers({ settings: SETTINGS, stacks: stacks({ OperatorPrincipalArn: SAME, OperatorExternalId: "" }) });
    expect(same).toMatchObject({ operatorPrincipalArn: SAME });
    expect(same).not.toHaveProperty("operatorExternalId");
    const none = await upgradeAnswers({ settings: SETTINGS, stacks: stacks({ OperatorPrincipalArn: "" }) });
    expect(none).not.toHaveProperty("operatorPrincipalArn");
  });
  it("refuses a stored whole-account or cross-account-without-id pair, saying who must change what, before any stack is touched", async () => {
    await expect(upgradeAnswers({ settings: SETTINGS, stacks: stacks({ OperatorPrincipalArn: `arn:aws:iam::${ACCOUNT}:root` }) })).rejects.toThrow(/whole account \(:root\).*Ask whoever owns the access stack to set its OperatorPrincipalArn/u);
    await expect(upgradeAnswers({ settings: SETTINGS, stacks: stacks({ OperatorPrincipalArn: OUTSIDE }) })).rejects.toThrow(/another AWS account.*OperatorExternalId/u);
  });
});
