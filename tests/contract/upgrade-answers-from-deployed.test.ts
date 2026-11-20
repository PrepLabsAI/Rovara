// Switch-over gap 3: `agentx upgrade --answers-from-deployed <file>` writes the answers
// `agentx deploy --mode upgrade --answers` reads, from the deployed environment and its settings,
// for either engine, deploying nothing. Round-trip: the file loads through loadDeployAnswers and
// deploys exactly what `agentx upgrade`'s own answers (upgradeAnswers) deploy.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDeployAnswers, progressLine } from "../../packages/cli/src/deploy/commands.js";
import { deployEnvironment, type DeployAnswers } from "../../packages/cli/src/deploy/deploy-environment.js";
import type { StackDescription, StackReader } from "../../packages/cli/src/environments/adopt.js";
import { writeEnvironmentSettings, type EnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { upgradeAnswers } from "../../packages/cli/src/upgrade/answers.js";
import { runUpgrade, type UpgradeDependencies } from "../../packages/cli/src/upgrade/run.js";
import { SETTINGS } from "../support/doctor-fakes.js";
import { allStackOutputs, fakeRelease, memoryInitSecrets, scriptedDeployer } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function answersPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentx-answers-from-deployed-"));
  dirs.push(dir);
  return join(dir, "answers.json");
}

const KEY_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf";
const CDK_SETTINGS: EnvironmentSettings = {
  ...SETTINGS, engine: "cdk", version: "1.2.3",
  access: { artifactBucket: "agentx-staging-access-artifactbucket-abc", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" },
};
const CONTROL_PLANE = { GitHubAppId: "", GitHubAppPrivateKeySecretArn: KEY_ARN, GitHubAppCredentialRef: "github-agentx-sdlc", CallbackSigningKey: "****", BudgetMonthlyUsd: "260", BudgetScope: "account", SlackAppPostedMessages: "accept" };
const IMAGES = { worker: `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-staging/worker@sha256:${"d".repeat(64)}`, slack: `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-staging/slack@sha256:${"e".repeat(64)}` };

function reader(controlPlane: Record<string, string>, access: Record<string, string> = { OperatorPrincipalArn: "" }): StackReader & { described: string[] } {
  const described: string[] = [];
  return {
    described,
    async describe(name): Promise<StackDescription | undefined> {
      described.push(name);
      const parameters = name === "agentx-staging-control-plane" ? controlPlane : name === "agentx-staging-access" ? access : {};
      return { status: "UPDATE_COMPLETE", outputs: allStackOutputs()[name] ?? {}, parameters };
    },
  };
}

const forbidden = (what: string) => () => { throw new Error(`test setup: --answers-from-deployed must not ${what}`); };

async function harness(controlPlane: Record<string, string> = CONTROL_PLANE, settings: EnvironmentSettings = CDK_SETTINGS) {
  const store = new MemoryParameterStore();
  await writeEnvironmentSettings(store, settings);
  const stacks = reader(controlPlane);
  const deps: UpgradeDependencies = {
    store, stacks,
    cloudFormation: { send: forbidden("call CloudFormation beyond describing stacks") },
    identity: { get: forbidden("read the caller") },
    loadRelease: forbidden("load a release"),
    sourceRelease: forbidden("build a source release"),
    notes: forbidden("fetch release notes"),
    prepare: forbidden("prepare a deploy"),
    cdkDiff: forbidden("diff"),
    ask: forbidden("ask"),
    isInteractive: () => false,
    githubWebhook: forbidden("touch GitHub"),
    doctor: forbidden("run doctor"),
    write: () => undefined,
    now: () => 0,
    cliVersion: undefined,
  };
  return { store, stacks, deps };
}

const options = { env: "staging", yes: false, allowReplace: [] as string[] };

describe("agentx upgrade --answers-from-deployed (switch-over gap 3)", () => {

  it("writes your own OIDC provider's identity, admin claim and values", async () => {
    const oidc: EnvironmentSettings = { ...CDK_SETTINGS, identity: { mode: "oidc", issuer: "https://idp.example.com", audience: "agentx", clientId: "cli" } };
    const h = await harness({ ...CONTROL_PLANE, AdminClaim: "groups", AdminValues: "[\"eng-admins\"]" }, oidc);
    const file = await answersPath();
    await runUpgrade({ ...options, answersFile: file }, h.deps);
    expect((await loadDeployAnswers(file, { mode: "upgrade" })).identity).toEqual({ mode: "oidc", issuer: "https://idp.example.com", audience: "agentx", clientId: "cli", adminClaim: "groups", adminValues: ["eng-admins"] });
  });

  it("a file that cannot be written is a fixed CONFIG_INVALID message, not a raw error", async () => {
    const h = await harness();
    const file = join(await answersPath(), "missing-dir", "answers.json");
    await expect(runUpgrade({ ...options, answersFile: file }, h.deps)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("could not be written (ENOENT); nothing was written") as unknown });
  });

  it("refuses an existing file, keeping it as it was", async () => {
    const h = await harness();
    const file = await answersPath();
    await writeFile(file, "keep me");
    await expect(runUpgrade({ ...options, answersFile: file }, h.deps)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(`${file} already exists; choose a new file`) as unknown });
    expect(await readFile(file, "utf8")).toBe("keep me");
  });

  it("refuses being combined with a deploy's or a bundle's flags", async () => {
    const h = await harness();
    const file = await answersPath();
    for (const extra of [{ exportDir: "/tmp/x" }, { to: "1.3.0" }, { releaseDir: "/tmp/r" }, { source: "/tmp/s" }, { yes: true }, { allowReplace: ["Table"] }]) {
      await expect(runUpgrade({ ...options, answersFile: file, ...extra }, h.deps)).rejects.toThrow("--answers-from-deployed only writes the deployed environment's answers");
    }
    await expect(stat(file)).rejects.toThrow();
  });

  describe("round-trip through loadDeployAnswers", () => {
    for (const [deployedAppId, engine] of [["", "cdk"], ["5389609", "cdk"]] as const) {
      it(`deploys exactly what agentx upgrade's own answers deploy (deployed GitHubAppId ${JSON.stringify(deployedAppId)}, ${engine} engine)`, async () => {
        const controlPlane = { ...CONTROL_PLANE, GitHubAppId: deployedAppId };
        const h = await harness(controlPlane);
        const file = await answersPath();
        await runUpgrade({ ...options, answersFile: file, images: IMAGES }, h.deps);

        const loaded = await loadDeployAnswers(file, { mode: "upgrade" });
        const own = await upgradeAnswers({ settings: CDK_SETTINGS, stacks: reader(controlPlane), images: IMAGES });
        // The install schema stays strict: an empty deployed id round-trips only as an upgrade.
        if (deployedAppId === "") await expect(loadDeployAnswers(file)).rejects.toThrow("github.appId");
        else expect(await loadDeployAnswers(file)).toEqual(loaded);

        const deployWith = async (answers: DeployAnswers) => {
          const store = new MemoryParameterStore();
          await writeEnvironmentSettings(store, { ...CDK_SETTINGS, engine });
          const deployer = scriptedDeployer(allStackOutputs(), Object.keys(allStackOutputs()));
          await deployEnvironment({
            mode: "upgrade", engine, answers, release: fakeRelease("1.3.0"), deployer, store,
            secrets: memoryInitSecrets({ "agentx/staging/callback-signing-key": "k".repeat(43) }), holder: "arn:aws:iam::123456789012:user/alice",
            deployedParameters: async (name) => (name === "agentx-staging-control-plane" ? controlPlane : name === "agentx-staging-access" ? { OperatorPrincipalArn: "" } : {}),
            declaredParameters: () => new Set(Object.keys(controlPlane)),
          });
          return deployer.requests.map((request) => ({ stackName: request.stackName, parameters: request.parameters }));
        };
        const fromFile = await deployWith(loaded);
        expect(fromFile).toEqual(await deployWith(own));
        expect(fromFile.find((request) => request.stackName === "agentx-staging-control-plane")?.parameters.GitHubAppId).toBe(deployedAppId);
      });
    }
  });

  it("the settings-legacy-keys event prints names only", () => {
    expect(progressLine({ kind: "settings-legacy-keys-dropped", env: "staging", keys: ["cloud", "cloudSignIn"] })).toBe("settings staging: dropped the legacy keys cloud, cloudSignIn");
  });
});
