// FR-026: `agentx upgrade --export <dir>` writes the upgrade for a platform team's pipeline. It makes
// no AWS write. Each stack's parameter file names every value this upgrade sets, and marks each
// deployed parameter an upgrade keeps (ruling F29: the operator's settings, the callback signing key,
// developer sign-in) UsePreviousValue, so the change set keeps them and no secret is in any file.
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { environmentStackName } from "@agentx/contracts";
import { templateParameterNames, upgradeKeptParameterNames, type DeployAnswers } from "../deploy/deploy-environment.js";
import { assertClaimable } from "../deploy/export-bundle.js";
import { SECRET_PARAMETERS, stackParameters, type DeployPart, type StackOutputs } from "../deploy/parameters.js";
import { assertReleaseCoversRegion, type LoadedRelease } from "../deploy/release.js";
import type { EnvironmentSettings } from "../environments/settings.js";

/** Never written: stackParameters checks the key's length, and SECRET_PARAMETERS are removed below. */
const PLACEHOLDER_KEY = "upgrade-bundle-placeholder-never-written-0000";

type Parameter = { ParameterKey: string; ParameterValue: string } | { ParameterKey: string; UsePreviousValue: true };

/** One stack's parameter file: what this upgrade sets, then what it keeps. A kept parameter the
 * target template no longer declares is not sent (CloudFormation refuses an undeclared one). */
function parameterFile(input: { part: DeployPart; computed: Record<string, string>; deployed: Record<string, string> | undefined; declared: ReadonlySet<string> | undefined }): Parameter[] {
  const computed = { ...input.computed };
  for (const secret of SECRET_PARAMETERS) delete computed[secret];
  const kept = [...upgradeKeptParameterNames(input.part)].filter((name) =>
    !Object.hasOwn(computed, name) && input.deployed?.[name] !== undefined && (input.declared === undefined || input.declared.has(name)));
  return [
    ...Object.entries(computed).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
    ...kept.map((ParameterKey) => ({ ParameterKey, UsePreviousValue: true as const })),
  ];
}

/**
 * Ruling F28: writes into a fresh directory next to `dir` and renames it onto `dir` only once every
 * file is written, as writeExportBundle does, so a failure never leaves half a bundle.
 */
export async function writeUpgradeBundle(input: {
  dir: string; settings: EnvironmentSettings; answers: DeployAnswers; release: LoadedRelease; parts: DeployPart[];
  outputs: Partial<Record<DeployPart, StackOutputs>>; deployed: Partial<Record<DeployPart, Record<string, string>>>;
}): Promise<{ dir: string; files: string[] }> {
  const { settings, release } = input;
  const { env, region } = settings;
  const version = release.manifest.version;
  assertReleaseCoversRegion(release, region);
  await assertClaimable(input.dir);

  const resolvedDir = resolve(input.dir);
  const parentDir = dirname(resolvedDir);
  await mkdir(parentDir, { recursive: true });
  const scratchDir = await mkdtemp(join(parentDir, `.${basename(resolvedDir)}.`));
  try {
    const files: string[] = [];
    const write = async (relativePath: string, content: string) => {
      const target = join(scratchDir, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      files.push(relativePath);
    };
    const full = { ...input.answers, release: release.manifest, callbackSigningKey: PLACEHOLDER_KEY };
    const bucket = settings.access?.artifactBucket ?? "<the access stack's ArtifactBucketName>";
    const role = settings.access?.cloudFormationRoleArn ?? "<the access stack's CloudFormationRoleArn>";
    const uploads: string[] = [];
    const steps: string[] = [];
    const changeSet = `agentx-upgrade-${version.replaceAll(".", "-")}`;
    await mkdir(join(scratchDir, "packages"), { recursive: true });
    for (const part of input.parts) {
      const stackName = environmentStackName(env, part);
      const parameters = parameterFile({ part, computed: stackParameters(part, full, input.outputs), deployed: input.deployed[part], declared: templateParameterNames(release, part, env) });
      await write(`parameters/${part}.json`, `${JSON.stringify(parameters, null, 2)}\n`);
      await write(`templates/${part}.template.json`, release.template(part, region, env));
      for (const pkg of release.manifest.packages.filter((entry) => entry.parts.includes(part))) {
        const relative = `packages/${pkg.assetId}.zip`;
        if (files.includes(relative)) continue;
        await copyFile(release.packagePath(pkg.assetId), join(scratchDir, relative));
        files.push(relative);
        uploads.push(`aws s3 cp ${relative} s3://${bucket}/packages/${pkg.assetId}.zip --metadata sha256=${pkg.sha256} --region ${region}`);
      }
      const key = `templates/${version}/${region}/${part}.template.json`;
      const roleFlag = part === "access" ? "" : ` --role-arn ${role}`;
      steps.push(
        `### ${stackName}`, "", "```",
        `aws s3 cp templates/${part}.template.json s3://${bucket}/${key} --region ${region}`,
        `aws cloudformation create-change-set --stack-name ${stackName} --change-set-name ${changeSet} --template-url https://${bucket}.s3.${region}.amazonaws.com/${key} --parameters file://parameters/${part}.json --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM${roleFlag} --region ${region}`,
        `aws cloudformation wait change-set-create-complete --stack-name ${stackName} --change-set-name ${changeSet} --region ${region}`,
        `aws cloudformation describe-change-set --stack-name ${stackName} --change-set-name ${changeSet} --region ${region}`,
        `aws cloudformation execute-change-set --stack-name ${stackName} --change-set-name ${changeSet} --region ${region}`,
        `aws cloudformation wait stack-update-complete --stack-name ${stackName} --region ${region}`,
        "```", "",
      );
    }
    const readme = [
      `# Upgrade AgentX environment ${env} to ${version}`, "",
      `Environment ${env} (account ${settings.account}, region ${region}) runs ${settings.version}. This bundle upgrades it to ${version}.`,
      "No file here holds a secret. The parameters an upgrade keeps (the operator's settings, the callback signing key and developer sign-in) are marked UsePreviousValue, so they keep their values. Any other parameter set by hand in the console goes back to the template's default, as it does with agentx upgrade.", "",
      `Deploy the stacks in this order, one at a time, each only after the one before it finished: ${input.parts.map((part) => environmentStackName(env, part)).join(", ")}.`,
      "Read each change set before executing it: a replaced or deleted table, user pool, bucket, key or secret loses its data.",
      ...(input.parts.includes("access") ? ["This release changes the access stack. The access stack deploys with your own credentials, without --role-arn; every other stack deploys through the CloudFormation role."] : []), "",
      "## 1. Upload the code packages", "", "```", ...(uploads.length === 0 ? ["# this release changes no code package"] : uploads), "```", "",
      "## 2. Deploy each stack", "", ...steps,
      "## 3. Record the new release", "",
      `When every stack is updated, the AgentX operator runs \`agentx --env ${env} upgrade --to ${version}\`. It finds no change left, records ${version} in the settings, and runs agentx doctor.`, "",
    ].join("\n");
    await write("README.md", readme);

    try {
      await rmdir(resolvedDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(scratchDir, resolvedDir);
    await chmod(resolvedDir, 0o755);
    return { dir: input.dir, files: files.sort() };
  } catch (error) {
    await rm(scratchDir, { recursive: true, force: true });
    throw error;
  }
}
