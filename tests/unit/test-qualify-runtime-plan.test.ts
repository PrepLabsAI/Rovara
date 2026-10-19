import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ec2WorkerBootScript, Ec2RuntimeBindingSchema } from "../../packages/contracts/src/session.js";
import { canonicalJson } from "../../packages/contracts/src/index.js";
import { ec2Binding } from "../../packages/cli/src/setup/project-add.js";
import {
  QUALIFICATION_POLL_TIMEOUT_MS,
  buildRunInstancesInput,
  classifyGetObjectFailure,
  describeRegisteredRows,
  formatQualificationPlan,
  parseQualifyArgs,
  planTestQualification,
  qualificationBinding,
  renderQualificationUserData,
  runTestQualification,
  type QualificationEffects,
  type QualificationFacts,
  type QualificationStep,
} from "../../scripts/test-qualify-runtime.js";

const ENV = "agentxlivetest123";
const RUN_ID = "0b6e6f0e-5d3b-4f0e-9d3a-2f1c4b7a8e90";
const WORKSPACE_ID = "6f1d3a52-77e0-4d57-8c1b-0a7f4f6a2d11";
const PREFIX = `e2e-runtime/${RUN_ID}/`;
const bootScript = readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");

const input = { env: ENV, profile: "agentx-test", region: "us-east-1", runId: RUN_ID, workspaceId: WORKSPACE_ID };
const plan = (overrides: Partial<typeof input> = {}, allowlist?: readonly string[]) => planTestQualification({ ...input, ...overrides }, allowlist);
const kinds = (steps: QualificationStep[]) => steps.map((step) => step.kind);
const find = <K extends QualificationStep["kind"]>(steps: QualificationStep[], kind: K) => steps.find((step): step is Extract<QualificationStep, { kind: K }> => step.kind === kind);

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

describe("planTestQualification", () => {
  it("plans the qualification in order: admin check, facts, volume, one launch, attach, challenge for the launched host, wait, then register", () => {
    const steps = plan();
    expect(kinds(steps)).toEqual([
      "check-admin-session",
      "resolve-facts",
      "create-volume",
      "run-instance",
      "attach-volume",
      "read-private-ip",
      "wait-ready",
      "issue-challenge",
      "upload-challenge",
      "poll-status",
      "download-proposal",
      "register",
      "delete-challenge",
      "print-registered-rows",
    ]);
  });

  it("issues the web/API challenge for the launched host (its private endpoint, generation 1, the workspace as correlation) and uploads it under the run's prefix", () => {
    const steps = plan();
    expect(find(steps, "issue-challenge")).toMatchObject({
      profile: "linux-arm64-web-api-v1",
      generation: 1,
      transportCorrelationId: WORKSPACE_ID,
      port: 8080,
    });
    expect(find(steps, "upload-challenge")).toMatchObject({ key: `${PREFIX}challenge.json` });
    expect(find(steps, "poll-status")).toMatchObject({ key: `${PREFIX}status.json`, timeoutMs: 60 * 60_000 });
    // The challenge is issued only once the worker says it is ready, so boot time does not use up its 60 minutes.
    expect(find(steps, "wait-ready")).toMatchObject({ key: `${PREFIX}ready.json`, statusKey: `${PREFIX}status.json` });
    expect(find(steps, "delete-challenge")).toMatchObject({ key: `${PREFIX}challenge.json` });
    expect(find(steps, "download-proposal")).toMatchObject({ key: `${PREFIX}proposal.json` });
    expect(QUALIFICATION_POLL_TIMEOUT_MS).toBe(60 * 60_000);
  });

  it("launches exactly one instance, with the run ID as its client token", () => {
    const steps = plan();
    expect(steps.filter((step) => step.kind === "run-instance")).toHaveLength(1);
    expect(find(steps, "run-instance")).toMatchObject({ minCount: 1, maxCount: 1, clientToken: RUN_ID, qualification: { prefix: PREFIX, profile: "linux-arm64-web-api-v1" } });
    expect(find(steps, "create-volume")).toMatchObject({ clientToken: RUN_ID });
  });

  it("refuses an environment that is not allowlisted, and a malformed run or workspace ID", () => {
    for (const env of ["production", "agentxlivetest124", ""]) {
      expect(() => plan({ env })).toThrow("test-qualify-runtime only targets allowlisted TEST installations");
    }
    expect(() => plan({}, [])).toThrow("only targets allowlisted TEST installations");
    for (const runId of ["", "not-a-uuid", RUN_ID.toUpperCase(), `${RUN_ID}/..`]) expect(() => plan({ runId }), runId).toThrow(/run ID/);
    expect(() => plan({ workspaceId: "x" })).toThrow(/workspace ID/);
    expect(() => plan({ runId: WORKSPACE_ID, workspaceId: WORKSPACE_ID })).not.toThrow();
  });

  it("describes the plan with its spend, and says nothing is applied without --apply", () => {
    const text = formatQualificationPlan(plan(), input);
    expect(text).toContain("m6g.large");
    expect(text).toContain("one instance");
    expect(text).toContain(PREFIX);
    expect(text).toMatch(/spend/i);
    expect(text).toMatch(/never terminates/);
  });
});

describe("the qualification instance's user data", () => {
  const qualification = { prefix: PREFIX, profile: "linux-arm64-web-api-v1" } as const;
  const decode = (encoded: string) => gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
  const exportNames = (script: string) => [...script.matchAll(/^export (\w+)=/gm)].map((match) => match[1]);

  it("is the worker's normal boot with only the validated qualification variables added", () => {
    const rendered = decode(renderQualificationUserData(facts, { workspaceId: WORKSPACE_ID, volumeId: "vol-0123456789abcdef0", qualification }, bootScript));
    const normal = ec2WorkerBootScript({
      workspaceId: WORKSPACE_ID, generation: 1, volumeId: "vol-0123456789abcdef0", expectNewVolume: true, workerImage: facts.settings.workerImage, executorImage: facts.settings.executorImage,
      invokePublicKey: facts.invokePublicKey, controlPlaneUrl: facts.controlPlaneUrl, modelProvider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6",
      promptCacheRetention: "long", logGroupName: facts.logGroupName,
    }, bootScript);
    const extra = exportNames(rendered).filter((name) => !exportNames(normal).includes(name));
    expect(extra.sort()).toEqual(["AGENTX_E2E_QUALIFICATION_BUCKET", "AGENTX_E2E_QUALIFICATION_PREFIX", "AGENTX_E2E_QUALIFICATION_PROFILE"]);
    expect(rendered).toContain(`export AGENTX_E2E_QUALIFICATION_PREFIX='${PREFIX}'`);
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
      renderQualificationUserData({ ...facts, settings: { ...facts.settings, ...settings } }, { workspaceId: WORKSPACE_ID, volumeId: "vol-0123456789abcdef0", qualification }, bootScript);
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

describe("buildRunInstancesInput", () => {
  it("is one instance from the environment's own launch template in its subnet, with the run ID as token and no instance type or profile of its own", () => {
    const request = buildRunInstancesInput(facts, { env: ENV, runId: RUN_ID, revision: "0123456789ab", userData: "dXNlcmRhdGE=" });
    expect(request).toMatchObject({
      MinCount: 1, MaxCount: 1, ClientToken: RUN_ID, UserData: "dXNlcmRhdGE=",
      LaunchTemplate: { LaunchTemplateId: facts.launchTemplateId, Version: "$Default" },
      SubnetId: facts.subnet.subnetId,
    });
    expect(request).not.toHaveProperty("InstanceType");
    expect(request).not.toHaveProperty("IamInstanceProfile");
    const tags = Object.fromEntries((request.TagSpecifications?.[0]?.Tags ?? []).map((tag) => [tag.Key ?? "", tag.Value ?? ""] as const));
    expect(tags).toMatchObject({ "agentx:env": ENV, "agentx:run": RUN_ID, "agentx:runtime-purpose": "web-api-qualification", "agentx:revision": "0123456789ab", "agentx:qualification-run": RUN_ID });
    expect(request.TagSpecifications?.[0]?.ResourceType).toBe("instance");
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
function harness(options: { statuses?: Array<Buffer | undefined>; readies?: Array<Buffer | undefined>; failAt?: string; adminFails?: boolean } = {}) {
  const calls: string[] = [];
  const bindings: unknown[] = [];
  const ready = [...(options.readies ?? [Buffer.from(JSON.stringify({ state: "READY", reason: "worker-healthy", finishedAt: "2026-10-19T11:50:00Z" }))])];
  const printed: string[] = [];
  let clock = 0;
  const statuses = [...(options.statuses ?? [Buffer.from(JSON.stringify({ state: "SUCCEEDED", reason: "qualified", finishedAt: "2026-10-19T12:00:00Z" }))])];
  const maybeFail = (name: string) => { if (options.failAt === name) throw new Error(`${name} failed`); };
  const effects: QualificationEffects = {
    async checkAdminSession() { calls.push("checkAdminSession"); if (options.adminFails) throw new Error("an unexpired administrator session is required"); },
    async resolveFacts() { calls.push("resolveFacts"); maybeFail("resolveFacts"); return facts; },
    async createVolume(request) { calls.push(`createVolume ${request.clientToken}`); maybeFail("createVolume"); return "vol-0123456789abcdef0"; },
    async runInstance(request) {
      calls.push(`runInstance min=${request.MinCount} max=${request.MaxCount} token=${request.ClientToken}`);
      maybeFail("runInstance");
      return "i-0123456789abcdef0";
    },
    async attachVolume(request) { calls.push(`attachVolume ${request.volumeId} ${request.instanceId}`); maybeFail("attachVolume"); },
    async privateIpOf(instanceId) { calls.push(`privateIpOf ${instanceId}`); maybeFail("privateIpOf"); return "10.42.128.17"; },
    async issueChallenge(request) { bindings.push(request.binding); calls.push(`issueChallenge ${request.endpoint} ${request.generation} ${request.transportCorrelationId} ${request.profile}`); maybeFail("issueChallenge"); return { challengeId: "c-1", file: "/tmp/challenge.json", expiresAt: "2026-10-19T13:00:00Z" }; },
    async putObject(key, file) { calls.push(`putObject ${key} ${file}`); maybeFail("putObject"); },
    async getObject(key) {
      calls.push(`getObject ${key}`);
      maybeFail("getObject");
      if (key.endsWith("ready.json")) return ready.shift();
      return key.endsWith("status.json") ? statuses.shift() : Buffer.from("proposal-bytes");
    },
    async deleteObject(key) { calls.push(`deleteObject ${key}`); maybeFail("deleteObject"); },
    saveProposal(bytes) { calls.push(`saveProposal ${bytes.toString()}`); return "/tmp/proposal.json"; },
    async register(file) { calls.push(`register ${file}`); maybeFail("register"); return JSON.stringify({ profileId: "linux-arm64-web-api-v1", featureCatalogId: "catalog-1", featureRevisions: { web: 1, api: 1 } }); },
    now: () => clock,
    async sleep(ms) { clock += ms; },
    print: (line) => printed.push(line),
  };
  return { effects, calls, printed, bindings, clockNow: () => clock };
}
const succeeded = Buffer.from(JSON.stringify({ state: "SUCCEEDED", reason: "qualified", finishedAt: "2026-10-19T12:00:00Z" }));
const failed = (reason: string) => Buffer.from(JSON.stringify({ state: "FAILED", reason, finishedAt: "2026-10-19T12:00:00Z" }));

describe("runTestQualification", () => {
  it("runs every step once, in order, and registers the downloaded proposal only after the status says SUCCEEDED", async () => {
    const { effects, calls, printed } = harness({ statuses: [undefined, undefined, succeeded] });
    await runTestQualification(plan(), effects, { revision: "0123456789ab", profile: "agentx-test", region: "us-east-1" });
    const names = calls.map((call) => call.split(" ")[0]);
    expect(names).toEqual([
      "checkAdminSession", "resolveFacts", "createVolume", "runInstance", "attachVolume", "privateIpOf", "getObject", "issueChallenge", "putObject",
      "getObject", "getObject", "getObject", "getObject", "saveProposal", "register", "deleteObject",
    ]);
    // The ready marker is read before the challenge is issued, never after.
    expect(calls.indexOf(`getObject ${PREFIX}ready.json`)).toBeLessThan(calls.findIndex((call) => call.startsWith("issueChallenge")));
    // The one-use challenge is deleted once registration has succeeded.
    expect(calls[calls.length - 1]).toBe(`deleteObject ${PREFIX}challenge.json`);
    expect(calls).toContain("runInstance min=1 max=1 token=" + RUN_ID);
    expect(calls).toContain("issueChallenge http://10.42.128.17:8080 1 " + WORKSPACE_ID + " linux-arm64-web-api-v1");
    expect(calls).toContain(`putObject ${PREFIX}challenge.json /tmp/challenge.json`);
    expect(calls).toContain("getObject " + PREFIX + "proposal.json");
    expect(calls).toContain("register /tmp/proposal.json");
    expect(calls.filter((call) => call.startsWith("runInstance"))).toHaveLength(1);
    expect(printed.join("\n")).toContain("PROFILE#linux-arm64-web-api-v1#web revision 1");
    expect(printed.join("\n")).toContain("PROFILE#linux-arm64-web-api-v1#api revision 1");
  });

  it("never registers when the status says FAILED, and leaves the instance for diagnosis with the way to end it", async () => {
    const { effects, calls, printed } = harness({ statuses: [failed("qualification-failed-exit-3")] });
    await expect(runTestQualification(plan(), effects, { revision: "0123456789ab", profile: "agentx-test", region: "us-east-1" })).rejects.toThrow(/qualification-failed-exit-3/);
    expect(calls.some((call) => call.startsWith("register") || call.startsWith("saveProposal"))).toBe(false);
    const text = printed.join("\n");
    expect(text).toContain("i-0123456789abcdef0");
    expect(text).toContain("vol-0123456789abcdef0");
    expect(text).toContain("aws ec2 terminate-instances --instance-ids i-0123456789abcdef0 --profile agentx-test --region us-east-1");
    expect(text).toMatch(/still running/);
  });

  it("never registers on a malformed, unrecognised or SUCCEEDED-looking-but-wrong status", async () => {
    for (const status of [Buffer.from("not json"), Buffer.from(JSON.stringify({ state: "DONE" })), Buffer.from(JSON.stringify({ state: "succeeded", reason: "x", finishedAt: "t" })), Buffer.from(JSON.stringify({ state: "SUCCEEDED" }))]) {
      const { effects, calls } = harness({ statuses: [status] });
      await expect(runTestQualification(plan(), effects, { revision: "0123456789ab", profile: "agentx-test", region: "us-east-1" }), status.toString()).rejects.toThrow(/status/);
      expect(calls.some((call) => call.startsWith("register"))).toBe(false);
    }
  });

  it("stops waiting after the challenge's 60 minutes, never registers, and keeps the instance", async () => {
    const { effects, calls, printed, clockNow } = harness({ statuses: [] });
    await expect(runTestQualification(plan(), effects, { revision: "0123456789ab", profile: "agentx-test", region: "us-east-1" })).rejects.toThrow(/no qualification status after 60 minutes/);
    expect(clockNow()).toBeGreaterThanOrEqual(60 * 60_000);
    expect(clockNow()).toBeLessThan(61 * 60_000 + 1);
    expect(calls.some((call) => call.startsWith("register"))).toBe(false);
    expect(printed.join("\n")).toContain("aws ec2 terminate-instances --instance-ids i-0123456789abcdef0");
  });

  it("launches nothing when the admin session or the stack facts are not usable", async () => {
    for (const options of [{ adminFails: true }, { failAt: "resolveFacts" }]) {
      const { effects, calls } = harness(options);
      await expect(runTestQualification(plan(), effects, { revision: "0123456789ab", profile: "agentx-test", region: "us-east-1" })).rejects.toThrow();
      expect(calls.some((call) => call.startsWith("createVolume") || call.startsWith("runInstance"))).toBe(false);
    }
  });

  it.each(["attachVolume", "privateIpOf", "issueChallenge", "putObject"])("never launches a second instance and prints the instance when %s fails", async (failAt) => {
    const { effects, calls, printed } = harness({ failAt });
    await expect(runTestQualification(plan(), effects, { revision: "0123456789ab", profile: "agentx-test", region: "us-east-1" })).rejects.toThrow(`${failAt} failed`);
    expect(calls.filter((call) => call.startsWith("runInstance"))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("register"))).toBe(false);
    expect(printed.join("\n")).toContain("aws ec2 terminate-instances --instance-ids i-0123456789abcdef0");
  });

  it("prints only the volume to delete when the launch itself fails", async () => {
    const { effects, printed } = harness({ failAt: "runInstance" });
    await expect(runTestQualification(plan(), effects, { revision: "0123456789ab", profile: "agentx-test", region: "us-east-1" })).rejects.toThrow("runInstance failed");
    const text = printed.join("\n");
    expect(text).toContain("vol-0123456789abcdef0");
    expect(text).toContain("aws ec2 delete-volume --volume-id vol-0123456789abcdef0");
    expect(text).not.toContain("terminate-instances");
  });
});

describe("runTestQualification: readiness, binding and cleanup", () => {
  const options = { revision: "0123456789ab", profile: "agentx-test", region: "us-east-1" };

  it("issues the challenge for every worker subnet the foundation lists, not only the one launched into", async () => {
    const { effects, bindings } = harness();
    await runTestQualification(plan(), effects, options);
    expect(bindings).toEqual([projectBinding]);
    expect((bindings[0] as { subnets: unknown[] }).subnets).toHaveLength(3);
  });

  it("waits for the worker's ready marker before it issues the challenge, so boot time never uses the challenge's lifetime", async () => {
    const { effects, calls, clockNow } = harness({ readies: [undefined, undefined, Buffer.from(JSON.stringify({ state: "READY" }))], statuses: [undefined, undefined, succeeded] });
    await runTestQualification(plan(), effects, options);
    const ready = calls.filter((call) => call.endsWith("ready.json"));
    expect(ready).toHaveLength(3);
    expect(clockNow()).toBe(2 * 30_000);
  });

  it("stops before issuing a challenge when the worker never becomes ready, keeping the instance", async () => {
    const { effects, calls, printed } = harness({ readies: [], statuses: [] });
    await expect(runTestQualification(plan(), effects, options)).rejects.toThrow(/not ready after/);
    expect(calls.some((call) => call.startsWith("issueChallenge") || call.startsWith("putObject"))).toBe(false);
    expect(printed.join("\n")).toContain("aws ec2 terminate-instances --instance-ids i-0123456789abcdef0");
  });

  it("stops at once, with the reason, when the worker reports FAILED before it is ready", async () => {
    const { effects, calls, clockNow } = harness({ readies: [], statuses: [failed("worker-not-healthy")] });
    await expect(runTestQualification(plan(), effects, options)).rejects.toThrow(/worker-not-healthy/);
    expect(calls.some((call) => call.startsWith("issueChallenge"))).toBe(false);
    expect(clockNow()).toBe(0);
  });

  it("deletes the one-use challenge after registration, and only after it", async () => {
    const { effects, calls } = harness();
    await runTestQualification(plan(), effects, options);
    expect(calls.indexOf(`deleteObject ${PREFIX}challenge.json`)).toBeGreaterThan(calls.findIndex((call) => call.startsWith("register")));
    const failedRun = harness({ statuses: [failed("qualification-failed-exit-3")] });
    await expect(runTestQualification(plan(), failedRun.effects, options)).rejects.toThrow();
    expect(failedRun.calls.some((call) => call.startsWith("deleteObject"))).toBe(false);
  });

  it("warns, naming the key, when the challenge cannot be deleted, and still succeeds", async () => {
    const { effects, printed } = harness({ failAt: "deleteObject" });
    await expect(runTestQualification(plan(), effects, options)).resolves.toBeUndefined();
    const text = printed.join("\n");
    expect(text).toMatch(/warning/i);
    expect(text).toContain(`${PREFIX}challenge.json`);
    expect(text).toContain("PROFILE#linux-arm64-web-api-v1#web revision 1");
  });

  it("prints the client token and the run tag, so an instance RunInstances created before it threw can be found", async () => {
    const { effects, printed } = harness({ failAt: "runInstance" });
    await expect(runTestQualification(plan(), effects, options)).rejects.toThrow("runInstance failed");
    const text = printed.join("\n");
    expect(text).toContain(`client token ${RUN_ID}`);
    expect(text).toContain(`aws ec2 describe-instances --filters Name=tag:agentx:qualification-run,Values=${RUN_ID} --profile agentx-test --region us-east-1`);
  });
});
