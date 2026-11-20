import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ec2WorkerBootScript, Ec2RuntimeBindingSchema } from "../../packages/contracts/src/session.js";
import { canonicalJson } from "../../packages/contracts/src/index.js";
import { ec2Binding } from "../../packages/cli/src/setup/project-add.js";
import { classifyGetObjectFailure, describeRegisteredRows, parseQualifyArgs, planTestQualification, qualificationBinding, roleNameFromArn, renderQualificationUserData, runTestQualification, type QualificationEffects, type QualificationFacts } from "../../scripts/test-qualify-runtime.js";

const ENV = "agentxlivetest123";
const RUN_ID = "0b6e6f0e-5d3b-4f0e-9d3a-2f1c4b7a8e90";
const WORKSPACE_ID = "6f1d3a52-77e0-4d57-8c1b-0a7f4f6a2d11";
const ROLE_ID = "AROAEXAMPLEROLEID123";
const INSTANCE_ID = "i-0123456789abcdef0";
const PREFLIGHT_KEY = `e2e-runtime/${RUN_ID}/preflight.json`;
const bootScript = readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");

const input = { env: ENV, profile: "agentx-test", region: "us-east-1", runId: RUN_ID, workspaceId: WORKSPACE_ID };
const plan = (overrides: Partial<typeof input> = {}, allowlist?: readonly string[]) => planTestQualification({ ...input, ...overrides }, allowlist);

const foundationOutputs = {
  Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0",
  // The foundation lists every worker subnet, in no particular zone order.
  Ec2WorkerSubnets: "us-east-1b=subnet-0bbbbbbbbbbbbbbbb,us-east-1a=subnet-0aaaaaaaaaaaaaaaa,us-east-1c=subnet-0cccccccccccccccc",
};
const { binding: projectBinding, launchSubnet } = qualificationBinding(foundationOutputs, "agentx-agentxlivetest123-foundation");

const facts: QualificationFacts = {
  region: "us-east-1",
  artifactBucket: "agentx-agentxlivetest123-control-artifacts82dd59a1-syx0unxsewcf",
  controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com",
  invokePublicKey: `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${"A".repeat(88)}`,
  logGroupName: "/agentx/agentxlivetest123/worker",
  launchTemplateId: "lt-0123456789abcdef0",
  workerRoleId: ROLE_ID,
  binding: projectBinding,
  subnet: launchSubnet,
  volumeSizeGiB: 20,
  settings: {
    workerImage: `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-test/worker@sha256:${"a".repeat(64)}`,
    executorImage: `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-test/executor@sha256:${"e".repeat(64)}`,
    modelProvider: "amazon-bedrock",
    modelId: "us.anthropic.claude-sonnet-4-6",
    promptCacheRetention: "long",
  },
};

describe("the qualification instance's user data", () => {
  const qualification = { profile: "linux-arm64-web-api-v1" } as const;
  const decode = (encoded: string) => gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
  const exportNames = (script: string) => [...script.matchAll(/^export (\w+)=/gm)].map((match) => match[1]);

  it("is the worker's normal boot with only the validated qualification variables added", () => {
    const rendered = decode(renderQualificationUserData(facts, { workspaceId: WORKSPACE_ID, volumeId: "vol-0123456789abcdef0", generation: 1, qualification }, bootScript));
    const normal = ec2WorkerBootScript({
      workspaceId: WORKSPACE_ID, generation: 1, volumeId: "vol-0123456789abcdef0", expectNewVolume: true, workerImage: facts.settings.workerImage, executorImage: facts.settings.executorImage,
      invokePublicKey: facts.invokePublicKey, controlPlaneUrl: facts.controlPlaneUrl, modelProvider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6",
      promptCacheRetention: "long", logGroupName: facts.logGroupName,
    }, bootScript);
    const extra = exportNames(rendered).filter((name) => !exportNames(normal).includes(name));
    expect(extra.sort()).toEqual(["AGENTX_E2E_QUALIFICATION_BUCKET", "AGENTX_E2E_QUALIFICATION_PROFILE", "AGENTX_E2E_QUALIFICATION_ROLE_ID"]);
    // The worker role's unique ID: the instance builds its own prefix from it and its instance ID.
    expect(rendered).toContain(`export AGENTX_E2E_QUALIFICATION_ROLE_ID='${ROLE_ID}'`);
    expect(rendered).toContain("export AGENTX_E2E_QUALIFICATION_PROFILE='linux-arm64-web-api-v1'");
    // The bucket comes from the live stack, and the executor image is on the worker for the qualifier to read.
    expect(rendered).toContain(`export AGENTX_E2E_QUALIFICATION_BUCKET='${facts.artifactBucket}'`);
    expect(rendered).toContain(`export EXECUTOR_IMAGE='${facts.settings.executorImage}'`);
    // A new volume, the first generation: the same values the provisioner gives a new workspace.
    expect(rendered).toContain("export AGENTX_EXPECT_NEW_VOLUME='true'");
    expect(rendered).toContain("export AGENTX_SESSION_GENERATION='1'");
    expect(rendered).toContain(`export AGENTX_WORKSPACE_ID='${WORKSPACE_ID}'`);
    // The challenge, which holds a one-use secret, is never part of what the instance is launched with.
    expect(rendered).not.toMatch(/challengeSecret|runtime-install-challenge\.json'/);
  });

  it("refuses a run whose settings have no executor image or are not pinned by digest", () => {
    const render = (settings: Partial<QualificationFacts["settings"]>) =>
      renderQualificationUserData({ ...facts, settings: { ...facts.settings, ...settings } }, { workspaceId: WORKSPACE_ID, volumeId: "vol-0123456789abcdef0", generation: 1, qualification }, bootScript);
    expect(() => render({ executorImage: undefined })).toThrow(/executor image/);
    expect(() => render({ executorImage: "111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-test/executor:latest" })).toThrow();
  });
});

describe("qualificationBinding", () => {
  it("binds the challenge to every worker subnet the foundation lists, in its order, exactly as project registration does", () => {
    expect(projectBinding.subnets).toEqual([
      { availabilityZone: "us-east-1b", subnetId: "subnet-0bbbbbbbbbbbbbbbb" },
      { availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" },
      { availabilityZone: "us-east-1c", subnetId: "subnet-0cccccccccccccccc" },
    ]);
    const digest = (binding: unknown) => createHash("sha256").update(canonicalJson(Ec2RuntimeBindingSchema.parse(binding))).digest("hex");
    // What `agentx project add` registers for the same outputs ...
    expect(digest(projectBinding)).toBe(digest(ec2Binding(foundationOutputs, "stack")));
    // ... and the literal binding the registered runtime row must equal.
    expect(digest(projectBinding)).toBe(digest({
      deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", volumeSizeGiB: 20, volumeType: "gp3",
      subnets: [
        { availabilityZone: "us-east-1b", subnetId: "subnet-0bbbbbbbbbbbbbbbb" },
        { availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" },
        { availabilityZone: "us-east-1c", subnetId: "subnet-0cccccccccccccccc" },
      ],
    }));
  });

  it("launches into one of those subnets, the first by zone", () => {
    expect(launchSubnet).toEqual({ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" });
    expect(projectBinding.subnets).toContainEqual(launchSubnet);
  });

  it("refuses outputs without the launch template or the subnets", () => {
    expect(() => qualificationBinding({ Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0" }, "stack")).toThrow(/Ec2WorkerSubnets/);
  });
});

describe("classifyGetObjectFailure", () => {
  it("treats a missing object and a denied read as not there yet (the principal may lack ListBucket), and anything else as an error", () => {
    for (const stderr of ["An error occurred (NoSuchKey) when calling the GetObject operation", "Not Found", "An error occurred (404)", "An error occurred (AccessDenied) when calling the GetObject operation: Access Denied", "Forbidden"]) {
      expect(classifyGetObjectFailure(stderr), stderr).toBe("absent");
    }
    for (const stderr of ["Unable to locate credentials", "The security token included in the request is expired", "Could not connect to the endpoint URL"]) {
      expect(classifyGetObjectFailure(stderr), stderr).toBe("error");
    }
  });
});

describe("roleNameFromArn", () => {
  it("takes the role name from a role ARN with or without a path, and refuses anything else", () => {
    expect(roleNameFromArn("arn:aws:iam::111122223333:role/agentx/agentxlivetest123/agentx-worker")).toBe("agentx-worker");
    expect(roleNameFromArn("arn:aws:iam::111122223333:role/worker")).toBe("worker");
    for (const bad of ["", "worker", "arn:aws:iam::111122223333:user/worker", "arn:aws:iam::111122223333:role/", "arn:aws:iam::111122223333:role/a/", "arn:aws:iam::111122223333:role/a b"]) {
      expect(() => roleNameFromArn(bad), bad).toThrow(/role ARN/);
    }
  });
});

describe("parseQualifyArgs", () => {
  it("requires env and profile, defaults to a dry run, and rejects positional, unknown and repeated options", () => {
    expect(parseQualifyArgs(["--env", ENV, "--profile", "agentx-test"])).toEqual({ env: ENV, profile: "agentx-test", region: "us-east-1", apply: false });
    expect(parseQualifyArgs(["--env", ENV, "--profile", "agentx-test", "--apply"]).apply).toBe(true);
    expect(() => parseQualifyArgs(["--profile", "agentx-test"])).toThrow("--env is required");
    expect(() => parseQualifyArgs(["--env", ENV])).toThrow("--profile is required");
    expect(() => parseQualifyArgs(["--env", ENV, "--profile", "p", "now"])).toThrow("unexpected argument now");
    expect(() => parseQualifyArgs(["apply", "--env", ENV, "--profile", "p"])).toThrow("unexpected argument apply");
    expect(() => parseQualifyArgs(["--env", ENV, "--profile", "p", "--instance-type", "x"])).toThrow("unknown option --instance-type");
    expect(() => parseQualifyArgs(["--env", ENV, "--env", ENV, "--profile", "p"])).toThrow("--env was given twice");
  });
});

describe("describeRegisteredRows", () => {
  it("names the two catalog rows and their revisions from the registration answer, bare or wrapped", () => {
    const answer = { profileId: "linux-arm64-web-api-v1", featureCatalogId: "catalog-1", featureRevisions: { web: 1, api: 2 }, proposalSha256: "f".repeat(64) };
    const expected = ["E2E_FEATURE_VERIFIER#catalog-1 / PROFILE#linux-arm64-web-api-v1#web revision 1", "E2E_FEATURE_VERIFIER#catalog-1 / PROFILE#linux-arm64-web-api-v1#api revision 2"];
    expect(describeRegisteredRows(JSON.stringify(answer))).toEqual(expected);
    expect(describeRegisteredRows(JSON.stringify({ ok: true, result: answer }))).toEqual(expected);
  });

  it("returns nothing it cannot read, rather than inventing rows", () => {
    expect(describeRegisteredRows("registered")).toEqual([]);
    expect(describeRegisteredRows(JSON.stringify({ featureCatalogId: "c" }))).toEqual([]);
  });
});

/** Effects that record every call and fail where a test says, so the run is driven with no AWS and no clock. */
function harness(options: { statuses?: Array<Buffer | undefined>; readies?: Array<Buffer | undefined>; failAt?: string; adminFails?: boolean; instanceId?: string; facts?: QualificationFacts; readBack?: Buffer; registeredGeneration?: number; movedGenerationAfterBoot?: number; lockHeld?: boolean; activeRunners?: number } = {}) {
  let booted = false;
  const calls: string[] = [];
  const bindings: unknown[] = [];
  const ready = [...(options.readies ?? [Buffer.from(JSON.stringify({ state: "READY", reason: "worker-healthy", finishedAt: "2026-10-19T11:50:00Z" }))])];
  const printed: string[] = [];
  const locks: string[] = [];
  const userData: string[] = [];
  let clock = 0;
  const statuses = [...(options.statuses ?? [Buffer.from(JSON.stringify({ state: "SUCCEEDED", reason: "qualified", finishedAt: "2026-10-19T12:00:00Z" }))])];
  const maybeFail = (name: string) => { if (options.failAt === name) throw new Error(`${name} failed`); };
  let preflightBody: Buffer | undefined;
  const effects: QualificationEffects = {
    async checkAdminSession() { calls.push("checkAdminSession"); if (options.adminFails) throw new Error("an unexpired administrator session is required"); },
    async resolveFacts() { calls.push("resolveFacts"); maybeFail("resolveFacts"); return options.facts ?? facts; },
    async putBytes(key, bytes) { calls.push(`putBytes ${key}`); maybeFail("putBytes"); preflightBody = bytes; },
    async getObjectStrict(key) { calls.push(`getObjectStrict ${key}`); maybeFail("getObjectStrict"); return options.readBack ?? preflightBody ?? Buffer.alloc(0); },
    async createVolume(request) { calls.push(`createVolume ${request.clientToken}`); maybeFail("createVolume"); return "vol-0123456789abcdef0"; },
    async runInstance(request) {
      userData.push(request.UserData ?? "");
      booted = true;
      calls.push(`runInstance min=${request.MinCount} max=${request.MaxCount} token=${request.ClientToken}`);
      maybeFail("runInstance");
      return options.instanceId ?? INSTANCE_ID;
    },
    async attachVolume(request) { calls.push(`attachVolume ${request.volumeId} ${request.instanceId}`); maybeFail("attachVolume"); },
    async setVolumeDeleteOnTermination(request) { calls.push(`setVolumeDeleteOnTermination ${request.volumeId} ${request.instanceId} ${request.device}`); maybeFail("setVolumeDeleteOnTermination"); },
    async privateIpOf(instanceId) { calls.push(`privateIpOf ${instanceId}`); maybeFail("privateIpOf"); return "10.42.128.17"; },
    async issueChallenge(request) { bindings.push(request.binding); calls.push(`issueChallenge ${request.endpoint} ${request.generation} ${request.transportCorrelationId} ${request.profile}`); maybeFail("issueChallenge"); return { challengeId: "c-1", file: "/tmp/challenge.json", expiresAt: "2026-10-19T13:00:00Z" }; },
    async putObject(key, file) { calls.push(`putObject ${key} ${file}`); maybeFail("putObject"); },
    async getObject(key) {
      calls.push(`getObject ${key}`);
      maybeFail("getObject");
      if (key.endsWith("ready.json")) return ready.shift();
      return key.endsWith("status.json") ? statuses.shift() : Buffer.from("proposal-bytes");
    },
    async deleteObject(key) { calls.push(`deleteObject ${key}`); maybeFail(key === PREFLIGHT_KEY ? "deletePreflight" : "deleteObject"); },
    saveProposal(bytes) { calls.push(`saveProposal ${bytes.toString()}`); return "/tmp/proposal.json"; },
    async recordSuccess(runId) { calls.push(`recordSuccess ${runId}`); maybeFail("recordSuccess"); },
    async recordModelCheckRunner(runner) { calls.push(`recordModelCheckRunner ${runner.roleId} ${runner.instanceId} ${runner.transportCorrelationId}`); maybeFail("recordModelCheckRunner"); },
    async register(file) { calls.push(`register ${file}`); maybeFail("register"); return JSON.stringify({ profileId: "linux-arm64-web-api-v1", featureCatalogId: "catalog-1", featureRevisions: { web: 1, api: 1 } }); },
    async nextGeneration() { return booted && options.movedGenerationAfterBoot !== undefined ? options.movedGenerationAfterBoot : options.registeredGeneration === undefined ? 1 : options.registeredGeneration + 1; },
    async countActiveRunners() { return options.activeRunners ?? 0; },
    async acquireLock(runId) { locks.push(`acquire ${runId}`); if (options.lockHeld) throw new Error("the renewal lock is held by another run"); },
    async releaseLock(runId) { locks.push(`release ${runId}`); },
    now: () => clock,
    async sleep(ms) { clock += ms; },
    print: (line) => printed.push(line),
  };
  return { effects, calls, printed, bindings, locks, userData, clockNow: () => clock };
}

describe("runTestQualification: the per-instance prefix and leftovers", () => {
  const options = { revision: "0123456789ab", profile: "agentx-test", region: "us-east-1" };

  it("refuses an instance ID RunInstances returns that is not an instance ID, before any key is built, and still prints it for cleanup", async () => {
    const { effects, calls, printed } = harness({ instanceId: "not-an-instance" });
    await expect(runTestQualification(plan(), effects, options)).rejects.toThrow(/instance ID/);
    expect(calls.some((call) => call.startsWith("issueChallenge") || /^putObject /.test(call))).toBe(false);
    expect(printed.join("\n")).toContain("aws ec2 terminate-instances --instance-ids not-an-instance");
  });

});
