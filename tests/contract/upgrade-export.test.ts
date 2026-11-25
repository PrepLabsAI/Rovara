import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_PLANE_FOUNDATION_PARAMETERS } from "@agentx/contracts";
import type { LoadedRelease } from "../../packages/cli/src/deploy/release.js";
import { writeUpgradeBundle } from "../../packages/cli/src/upgrade/export.js";
import { SETTINGS } from "../support/doctor-fakes.js";
import { allStackOutputs, fakeRelease } from "../support/init-fakes.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const ASSET = "a".repeat(64);
const settings = { ...SETTINGS, access: { artifactBucket: "agentx-staging-access-artifactbucket-abc", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" } };

async function releaseWithPackage(declared: Record<string, unknown> = { CallbackSigningKey: {}, BudgetMonthlyUsd: {}, GitHubAppId: {} }, packageFile?: string): Promise<LoadedRelease> {
  const dir = await mkdtemp(join(tmpdir(), "agentx-upgrade-release-"));
  dirs.push(dir);
  await writeFile(join(dir, `${ASSET}.zip`), "zip bytes");
  const base = fakeRelease("1.3.0");
  return {
    ...base,
    manifest: { ...base.manifest, packages: [{ assetId: ASSET, file: `packages/${ASSET}.zip`, sha256: "f".repeat(64), parts: ["control-plane"], bucketParameter: "AssetBucket", keyParameter: "AssetKey", hashParameter: "AssetHash", keyParameterValue: `packages/${ASSET}.zip` }] },
    template: (part) => JSON.stringify({ Parameters: part === "control-plane" ? declared : {} }),
    packagePath: () => packageFile ?? join(dir, `${ASSET}.zip`),
  };
}

const answers = {
  env: "staging", region: "us-east-1", account: "123456789012", models: SETTINGS.models, identity: { mode: "cognito" as const },
  github: { appId: "123", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf" },
};
const outputs = Object.fromEntries(Object.entries(allStackOutputs()).map(([name, value]) => [name.replace("agentx-staging-", ""), value]));

async function freshDir(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "agentx-upgrade-bundle-"));
  dirs.push(parent);
  return join(parent, "bundle");
}

describe("agentx upgrade --export (FR-026)", () => {
  it("writes templates, parameter files, packages and a README, with no secret, keeping what must not change", async () => {
    const out = await freshDir();
    const result = await writeUpgradeBundle({
      dir: out, settings, answers, release: await releaseWithPackage(), parts: ["foundation", "identity", "runtime", "control-plane", "slack"], outputs,
      deployed: { "control-plane": { CallbackSigningKey: "****", BudgetMonthlyUsd: "250", GitHubAppId: "123", DeveloperSignInSlack: "enabled" } },
    });
    expect(result.files).toEqual(expect.arrayContaining(["README.md", "templates/control-plane.template.json", "parameters/control-plane.json", `packages/${ASSET}.zip`]));
    const parameters = JSON.parse(await readFile(join(out, "parameters", "control-plane.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(parameters).toContainEqual({ ParameterKey: "CallbackSigningKey", UsePreviousValue: true });
    expect(parameters).toContainEqual({ ParameterKey: "BudgetMonthlyUsd", UsePreviousValue: true });
    expect(parameters).toContainEqual({ ParameterKey: "GitHubAppId", ParameterValue: "123" });
    // A parameter the new template does not declare is not sent at all.
    expect(parameters.find((entry) => entry.ParameterKey === "DeveloperSignInSlack")).toBeUndefined();
    for (const file of await readdir(join(out, "parameters"))) expect(await readFile(join(out, "parameters", file), "utf8")).not.toMatch(/"ParameterKey": "CallbackSigningKey",\s*"ParameterValue"/);
    const readme = await readFile(join(out, "README.md"), "utf8");
    expect(readme).toContain("aws cloudformation create-change-set --stack-name agentx-staging-control-plane");
    expect(readme).toContain("--role-arn arn:aws:iam::123456789012:role/agentx-staging-cloudformation");
    expect(readme).toContain(`aws s3 cp packages/${ASSET}.zip s3://agentx-staging-access-artifactbucket-abc/packages/${ASSET}.zip --metadata sha256=${"f".repeat(64)} --region us-east-1`);
    expect(readme.indexOf("agentx-staging-runtime")).toBeLessThan(readme.indexOf("agentx-staging-control-plane --change-set-name"));
    expect(readme).toContain("agentx --env staging upgrade --to 1.3.0");
    expect(readme).not.toContain("agentx-staging-access --change-set-name");
  });

  // F1 L1a-1, the one carry rule (deploy/carry.ts): every deployed parameter the new template declares and the upgrade does not supply is UsePreviousValue, not only the operator's list.
  it("marks every other deployed parameter the new template declares UsePreviousValue, as the engines carry it, and sends none the template does not declare", async () => {
    const out = await freshDir();
    await writeUpgradeBundle({
      dir: out, settings, answers,
      release: await releaseWithPackage({ CallbackSigningKey: {}, BudgetMonthlyUsd: {}, GitHubAppId: {}, PromptCacheRetention: {}, SomeHandSetParameter: {}, NewInThisRelease: {} }), parts: ["control-plane"], outputs,
      deployed: { "control-plane": { CallbackSigningKey: "****", BudgetMonthlyUsd: "250", GitHubAppId: "123", PromptCacheRetention: "short", SomeHandSetParameter: "by-hand", RemovedInThisRelease: "x" } },
    });
    const parameters = JSON.parse(await readFile(join(out, "parameters", "control-plane.json"), "utf8")) as Array<Record<string, unknown>>;
    for (const name of ["PromptCacheRetention", "SomeHandSetParameter"]) expect(parameters, name).toContainEqual({ ParameterKey: name, UsePreviousValue: true });
    expect(parameters.find((entry) => entry.ParameterKey === "RemovedInThisRelease")).toBeUndefined();
    expect(parameters.find((entry) => entry.ParameterKey === "NewInThisRelease")).toBeUndefined();
    expect(parameters.filter((entry) => entry.ParameterKey === "GitHubAppId")).toEqual([{ ParameterKey: "GitHubAppId", ParameterValue: "123" }]);
    expect(await readFile(join(out, "README.md"), "utf8")).toContain("Every parameter this upgrade does not set is marked UsePreviousValue");
  });

  it("does not send an empty SlackTeamId when the stored sign-in names no team id: the deployed one is kept", async () => {
    const out = await freshDir();
    const signIn = { settings: { schemaVersion: 1 as const, env: "staging", slack: false, github: { clientId: "gh-client", clientSecretName: "agentx/staging/developer-github" }, since: { github: 3 }, updatedAt: "2026-11-25T00:00:00.000Z", updatedBy: "someone" } };
    await writeUpgradeBundle({
      dir: out, settings, answers: { ...answers, developerSignIn: signIn },
      release: await releaseWithPackage({ CallbackSigningKey: {}, GitHubAppId: {}, SlackTeamId: {}, DeveloperSignInSlack: {}, DeveloperSignInGithub: {}, DeveloperGithubClientId: {}, DeveloperGithubSince: {} }), parts: ["control-plane"], outputs,
      deployed: { "control-plane": { CallbackSigningKey: "****", GitHubAppId: "123", SlackTeamId: "T0DEPLOYED", DeveloperSignInSlack: "disabled", DeveloperSignInGithub: "enabled", DeveloperGithubClientId: "gh-client", DeveloperGithubSince: "3" } },
    });
    const parameters = JSON.parse(await readFile(join(out, "parameters", "control-plane.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(parameters).toContainEqual({ ParameterKey: "SlackTeamId", UsePreviousValue: true });
    expect(parameters.filter((entry) => entry.ParameterKey === "SlackTeamId")).toHaveLength(1);
    expect(parameters).toContainEqual({ ParameterKey: "DeveloperSignInGithub", ParameterValue: "enabled" });
    expect(parameters).toContainEqual({ ParameterKey: "DeveloperSignInSlack", ParameterValue: "disabled" });
  });

  it("refuses a release that adds a secret parameter, which a bundle cannot carry", async () => {
    const out = await freshDir();
    await expect(writeUpgradeBundle({ dir: out, settings, answers, release: await releaseWithPackage(), parts: ["control-plane"], outputs, deployed: { "control-plane": { GitHubAppId: "123" } } }))
      .rejects.toThrow("release 1.3.0 adds secret CallbackSigningKey, which a bundle cannot carry; run agentx upgrade with admin credentials");
    expect(await readdir(join(out, ".."))).toEqual([]);
  });

  it("refuses, with the next step, a release whose stack reads an output the deployed stack does not have yet (final review M5)", async () => {
    const out = await freshDir();
    const [missing] = CONTROL_PLANE_FOUNDATION_PARAMETERS;
    const foundation = { ...outputs.foundation } as Record<string, string>;
    delete foundation[missing];
    await expect(writeUpgradeBundle({ dir: out, settings, answers, release: await releaseWithPackage(), parts: ["control-plane"], outputs: { ...outputs, foundation }, deployed: { "control-plane": { CallbackSigningKey: "****" } } }))
      .rejects.toMatchObject({
        code: "CONFIG_INVALID",
        message: `CONFIG_INVALID: release 1.3.0 needs output ${missing} of stack agentx-staging-foundation, which the deployed stack does not have yet, so one bundle cannot upgrade agentx-staging-control-plane. Run agentx --env staging upgrade --to 1.3.0 with admin credentials instead: it deploys agentx-staging-foundation first, then reads its new output`,
      });
    expect(await readdir(join(out, ".."))).toEqual([]);
  });

  it("refuses a directory that is not empty", async () => {
    const out = await mkdtemp(join(tmpdir(), "agentx-upgrade-bundle-"));
    dirs.push(out);
    await writeFile(join(out, "keep.txt"), "x");
    await expect(writeUpgradeBundle({ dir: out, settings, answers, release: await releaseWithPackage(), parts: ["slack"], outputs, deployed: {} })).rejects.toThrow("is not empty");
  });

  it("refuses a region the release does not cover, writing nothing", async () => {
    const out = await freshDir();
    const release = { ...(await releaseWithPackage()), regions: () => ["eu-west-1"] };
    await expect(writeUpgradeBundle({ dir: out, settings, answers, release, parts: ["slack"], outputs, deployed: {} })).rejects.toThrow("us-east-1");
    expect(await readdir(join(out, ".."))).toEqual([]);
  });
});
