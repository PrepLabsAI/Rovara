import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OPERATOR_PARAMETERS, SECRET_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { upgradeKeptParameterNames } from "../../packages/cli/src/deploy/deploy-environment.js";
import type { LoadedRelease } from "../../packages/cli/src/deploy/release.js";
import { SIGN_IN_PARAMETER_NAMES } from "../../packages/cli/src/signin/settings.js";
import { writeUpgradeBundle } from "../../packages/cli/src/upgrade/export.js";
import { SETTINGS } from "../support/doctor-fakes.js";
import { allStackOutputs, fakeRelease } from "../support/init-fakes.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const ASSET = "a".repeat(64);
const settings = { ...SETTINGS, access: { artifactBucket: "agentx-staging-access-artifactbucket-abc", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" } };
const CONTROL_PLANE_DECLARED = { CallbackSigningKey: {}, BudgetMonthlyUsd: {}, GitHubAppId: {}, DeveloperSignInSlack: {}, ConsoleSetting: {} };

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

async function allFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return Promise.all(entries.filter((entry) => entry.isFile()).map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")));
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

  it("never writes a secret value: the signing key is kept with UsePreviousValue, and the placeholder never reaches a file", async () => {
    const out = await freshDir();
    await writeUpgradeBundle({
      dir: out, settings, answers, release: await releaseWithPackage(), parts: ["control-plane"], outputs,
      deployed: { "control-plane": { CallbackSigningKey: "****", BudgetMonthlyUsd: "250", GitHubAppId: "123" } },
    });
    for (const text of await allFiles(out)) {
      expect(text).not.toContain("placeholder-never-written");
      expect(text).not.toContain("****");
    }
    const parameters = JSON.parse(await readFile(join(out, "parameters", "control-plane.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(parameters.filter((entry) => entry.ParameterKey === "CallbackSigningKey")).toEqual([{ ParameterKey: "CallbackSigningKey", UsePreviousValue: true }]);
  });

  it("keeps exactly what agentx upgrade keeps: operator settings, secrets and sign-in, never a console-set parameter (ruling F29)", async () => {
    const out = await freshDir();
    await writeUpgradeBundle({
      dir: out, settings, answers, release: await releaseWithPackage(CONTROL_PLANE_DECLARED), parts: ["control-plane"], outputs,
      deployed: { "control-plane": { CallbackSigningKey: "****", BudgetMonthlyUsd: "250", GitHubAppId: "123", DeveloperSignInSlack: "enabled", ConsoleSetting: "by hand" } },
    });
    const parameters = JSON.parse(await readFile(join(out, "parameters", "control-plane.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(parameters).toContainEqual({ ParameterKey: "DeveloperSignInSlack", UsePreviousValue: true });
    expect(parameters.find((entry) => entry.ParameterKey === "ConsoleSetting")).toBeUndefined();
    expect([...upgradeKeptParameterNames("control-plane")].sort()).toEqual([...OPERATOR_PARAMETERS["control-plane"], ...SECRET_PARAMETERS, ...SIGN_IN_PARAMETER_NAMES].sort());
    expect([...upgradeKeptParameterNames("slack")].sort()).toEqual([...OPERATOR_PARAMETERS.slack, ...SECRET_PARAMETERS].sort());
  });

  it("carries a changed access stack for the platform team, deployed with their own credentials (question 9)", async () => {
    const out = await freshDir();
    await writeUpgradeBundle({ dir: out, settings, answers, release: await releaseWithPackage(), parts: ["access", "foundation"], outputs, deployed: {} });
    const readme = await readFile(join(out, "README.md"), "utf8");
    const accessLine = readme.split("\n").find((line) => line.startsWith("aws cloudformation create-change-set --stack-name agentx-staging-access "));
    expect(accessLine).toBeDefined();
    expect(accessLine).not.toContain("--role-arn");
    expect(readme.indexOf("agentx-staging-access --change-set-name")).toBeLessThan(readme.indexOf("agentx-staging-foundation --change-set-name"));
    expect(readme).toContain("The access stack deploys with your own credentials");
  });

  it("refuses a directory that is not empty", async () => {
    const out = await mkdtemp(join(tmpdir(), "agentx-upgrade-bundle-"));
    dirs.push(out);
    await writeFile(join(out, "keep.txt"), "x");
    await expect(writeUpgradeBundle({ dir: out, settings, answers, release: await releaseWithPackage(), parts: ["slack"], outputs, deployed: {} })).rejects.toThrow("is not empty");
  });

  it("leaves nothing behind when a write fails partway (ruling F28)", async () => {
    const out = await freshDir();
    const release = await releaseWithPackage(undefined, join(tmpdir(), "agentx-no-such-package.zip"));
    await expect(writeUpgradeBundle({ dir: out, settings, answers, release, parts: ["foundation", "control-plane"], outputs, deployed: {} })).rejects.toThrow();
    expect(await readdir(join(out, ".."))).toEqual([]);
  });

  it("refuses a region the release does not cover, writing nothing", async () => {
    const out = await freshDir();
    const release = { ...(await releaseWithPackage()), regions: () => ["eu-west-1"] };
    await expect(writeUpgradeBundle({ dir: out, settings, answers, release, parts: ["slack"], outputs, deployed: {} })).rejects.toThrow("us-east-1");
    expect(await readdir(join(out, ".."))).toEqual([]);
  });
});
