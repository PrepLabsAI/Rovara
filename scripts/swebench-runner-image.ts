// npm run swebench:runner-image -- [--env <name>] [--region <region>] [--repository <name>] [--profile <profile>] [--allow-dirty] [--dry-run]
//
// Spec 043 FR-008: builds the worker image for linux/amd64 (SWE-bench's task images are x86 only),
// pushes it to the worker repository with a `swebench-` tag, and points the eval runner-image
// parameter at its digest. The broker reads that parameter per run, so no other release is needed.
// A production write: run it yourself, after the eval stack is deployed (docs/swebench-eval.md).
import { environmentSettingsPrefix, SWEBENCH_SETTING_PARAMETERS, WORKER_INVOCATION_FEATURES, type SwebenchRunnerFeatures } from "@agentx/contracts";
import { Runner, assertDigestImage, buildAndPushImage, parseReleaseArgs, splitEnvFlag, verifyRepositoryImage } from "./release-common.js";

const LEGACY_SETTINGS_PREFIX = "/agentx/production/";

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  process.stdout.write("Usage: npm run swebench:runner-image -- [--env <name>] [--region <region>] [--repository <name>] [--profile <profile>] [--allow-dirty] [--dry-run]\n");
  process.exit(0);
}
const { env, rest } = splitEnvFlag(argv);
const options = parseReleaseArgs(rest);
const settingsPrefix = env === undefined ? LEGACY_SETTINGS_PREFIX : environmentSettingsPrefix(env);
const parameterName = `${settingsPrefix}${SWEBENCH_SETTING_PARAMETERS.runnerImage}`;
const featuresParameterName = `${settingsPrefix}${SWEBENCH_SETTING_PARAMETERS.runnerFeatures}`;

const runner = new Runner(options);
const revision = runner.capture("git", ["rev-parse", "HEAD"]).stdout.trim();
if (!options.allowDirty && runner.capture("git", ["status", "--porcelain"]).stdout.trim() !== "") {
  throw new Error("working tree is dirty; commit changes or pass --allow-dirty explicitly");
}
const identity = JSON.parse(runner.aws(["sts", "get-caller-identity", "--output", "json"]).stdout) as { Account?: string };
if (!identity.Account) throw new Error("AWS did not return an account ID");
const repositoryUri = `${identity.Account}.dkr.ecr.${options.region}.amazonaws.com/${options.repository}`;

if (options.dryRun) {
  process.stdout.write([
    `Would build packages/worker for linux/amd64 at ${revision.slice(0, 12)},`,
    `push it to ${repositoryUri} with a swebench- tag,`,
    `and set ${parameterName} in ${options.region} to its digest, then ${featuresParameterName} to the run fields it parses.`,
    "",
  ].join("\n"));
  process.exit(0);
}

const image = await buildAndPushImage(runner, options, {
  repository: options.repository,
  repositoryUri,
  dockerfile: "environments/base/Dockerfile",
  localName: "agentx-swebench-runner",
  platform: "linux/amd64",
  tagPrefix: "swebench-",
  smokeTest: async (smoke, local) => {
    // What the runner uses besides the worker: its entry point, the S3 client, git, uv for the
    // harness, and the Docker CLI for the task containers.
    const result = smoke.capture("docker", [
      "run", "--rm", "--platform", "linux/amd64", "--entrypoint", "sh", local, "-c",
      "test -f packages/worker/dist/swebench-main.js && node -e \"import('@aws-sdk/client-s3')\" && git --version && uv --version && python3 --version && docker --version",
    ], true);
    if (result.status !== 0) {
      process.stderr.write(result.stderr);
      throw new Error("the runner image lacks its entry point, the S3 client, git, uv, Python or the Docker CLI");
    }
  },
}, revision);
assertDigestImage(image, repositoryUri);
verifyRepositoryImage(runner, options, image);
runner.aws(["ssm", "put-parameter", "--region", options.region, "--name", parameterName, "--type", "String", "--value", image, "--overwrite"]);
// Spec 053: after the image, and naming it, so the broker never reads features for an image that
// lacks them; a features value left by an older image names that image and is ignored.
const features: SwebenchRunnerFeatures = { runnerImage: image, features: [...WORKER_INVOCATION_FEATURES] };
runner.aws(["ssm", "put-parameter", "--region", options.region, "--name", featuresParameterName, "--type", "String", "--value", JSON.stringify(features), "--overwrite"]);
process.stdout.write(`\nSWE-bench runner image: ${image}\nWrote ${parameterName} and ${featuresParameterName}.\n`);
