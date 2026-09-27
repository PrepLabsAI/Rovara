import { describe, expect, it } from "vitest";
import { AgentXError } from "@agentx/contracts";
import { awsPrerequisiteChecks, checkPrerequisites, DEDICATED_ACCOUNT_NOTE, endpointMissing, modelCheckProblem } from "../../packages/cli/src/init/prerequisites.js";
import type { InitAnswers } from "../../packages/cli/src/init/install-state.js";
import type { ParameterStore } from "../../packages/cli/src/environments/parameter-store.js";
import type { CommandRunner } from "../../packages/cli/src/deploy/cdk-engine.js";
import { passingChecks, sampleAnswers, scriptedPrompter } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const caller = { account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/Admin/alice" };
const awsError = (name: string, message: string) => Object.assign(new Error(message), { name });

async function run(answers: InitAnswers, checks = passingChecks(), prompter = scriptedPrompter([])) {
  const lines: string[] = [];
  await checkPrerequisites({ answers, releaseRegions: ["us-east-1"], caller, checks, prompter, write: (line) => lines.push(line) });
  return lines;
}

describe("init prerequisites", () => {
  it("names the account, recommends a dedicated account, and checks each distinct model once", async () => {
    const checks = passingChecks();
    const lines = await run(sampleAnswers({ models: { orchestrator: "a", classifier: "b", worker: "a" } }), checks);
    expect(lines[0]).toBe("AWS account 123456789012 as arn:aws:sts::123456789012:assumed-role/Admin/alice");
    expect(lines).toContain(DEDICATED_ACCOUNT_NOTE);
    expect(checks.models).toEqual(["a", "b"]);
  });

  it("stops when the region has no AgentCore, saying nothing was created", async () => {
    const checks = passingChecks({ agentCore: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND bedrock-agentcore-control.eu-north-1.amazonaws.com"), { code: "ENOTFOUND" }); } });
    await expect(run(sampleAnswers({ region: "eu-north-1" }), checks)).rejects.toThrow(
      /init cannot start; nothing was created:\n- this release does not cover region eu-north-1; it covers: us-east-1\n- Amazon Bedrock AgentCore Runtime is not available in eu-north-1/,
    );
  });

  it("counts an AgentCore access denial as the service being present", async () => {
    await expect(run(sampleAnswers(), passingChecks({ agentCore: async () => { throw awsError("AccessDeniedException", "not authorized"); } }))).resolves.toBeDefined();
  });

  it("explains the Anthropic use-case form, an id that needs an inference profile, and an unknown id (Review Focus 5)", () => {
    const form = modelCheckProblem({ modelId: "us.anthropic.claude-sonnet-4-6", role: "orchestrator", region: "us-east-1", error: awsError("AccessDeniedException", "Model use case details have not been submitted for this account.") });
    expect(form).toBe("us.anthropic.claude-sonnet-4-6: Anthropic models need a one-time use-case form in this account. Open the Bedrock console in us-east-1, Model catalog, choose the model and submit the form, then run agentx init again");
    const profile = modelCheckProblem({ modelId: "anthropic.claude-haiku-4-5-20251001-v1:0", role: "classifier", region: "us-east-1", error: awsError("ValidationException", "Invocation of model ID anthropic.claude-haiku-4-5-20251001-v1:0 with on-demand throughput isn't supported.") });
    expect(profile).toBe("anthropic.claude-haiku-4-5-20251001-v1:0 must be called through an inference profile in us-east-1; use us.anthropic.claude-haiku-4-5-20251001-v1:0 instead (--classifier-model)");
    const unknown = modelCheckProblem({ modelId: "made.up-v1", role: "worker", region: "us-east-1", error: awsError("ValidationException", "The provided model identifier is invalid.") });
    expect(unknown).toBe("made.up-v1 is not a Bedrock model id available in us-east-1; check the id, or choose another with --worker-model");
    const denied = modelCheckProblem({ modelId: "zai.glm-4.7", role: "orchestrator", region: "us-east-1", error: awsError("AccessDeniedException", "You don't have access to the model with the specified model ID.") });
    expect(denied).toContain("Enable access in the Bedrock console (Model access), or choose another model with --orchestrator-model");
  });

  it("retries a throttled model check once, then gives up with a try-again message (Review Focus 5)", async () => {
    let calls = 0;
    const flaky = passingChecks({ converse: async () => { calls += 1; if (calls === 1) throw awsError("ThrottlingException", "Too many requests"); } });
    await expect(run(sampleAnswers({ models: { orchestrator: "a", classifier: "a", worker: "a" } }), flaky)).resolves.toBeDefined();
    expect(calls).toBe(2);
    const throttled = passingChecks({ converse: async () => { throw awsError("ThrottlingException", "Too many requests"); } });
    await expect(run(sampleAnswers({ models: { orchestrator: "a", classifier: "a", worker: "a" } }), throttled)).rejects.toThrow("Bedrock throttled the check of a; wait a minute and run agentx init again");
  });

  it("reports every problem at once", async () => {
    const checks = passingChecks({ converse: async (id) => { throw awsError("ValidationException", `The provided model identifier is invalid. ${id}`); } });
    await expect(run(sampleAnswers({ models: { orchestrator: "x", classifier: "y", worker: "z" } }), checks)).rejects.toThrow(/- x is not.*\n- y is not.*\n- z is not/s);
  });

  it("for the cdk engine, needs Node 22.19 or later and offers cdk bootstrap, running it only when every other check passed", async () => {
    await expect(run(sampleAnswers({ engine: "cdk" }), passingChecks({ commandVersion: async () => "v20.11.0" }))).rejects.toThrow("the cdk engine needs Node 22.19 or later (found v20.11.0)");

    const yes = passingChecks({ cdkBootstrapped: async () => false });
    await run(sampleAnswers({ engine: "cdk" }), yes, scriptedPrompter([true]));
    expect(yes.bootstraps).toBe(1);

    const no = passingChecks({ cdkBootstrapped: async () => false });
    await expect(run(sampleAnswers({ engine: "cdk" }), no, scriptedPrompter([false]))).rejects.toThrow("run npx cdk bootstrap aws://123456789012/us-east-1, or use --engine templates, which needs no bootstrap");
    expect(no.bootstraps).toBe(0);

    const blocked = passingChecks({ cdkBootstrapped: async () => false, converse: async () => { throw awsError("ValidationException", "The provided model identifier is invalid."); } });
    await expect(run(sampleAnswers({ engine: "cdk" }), blocked, scriptedPrompter([]))).rejects.toThrow("is not a Bedrock model id");
    expect(blocked.bootstraps).toBe(0);
  });

  it("checks your own OIDC provider's discovery document names the same issuer", async () => {
    const oidc = sampleAnswers({ identity: { mode: "oidc", issuer: "https://id.example.com", audience: "a", clientId: "c", adminClaim: "groups", adminValues: ["x"] } });
    await expect(run(oidc, passingChecks({ oidcDiscovery: async () => ({ issuer: "https://other.example.com" }) }))).rejects.toThrow(
      "the OIDC discovery document at https://id.example.com/.well-known/openid-configuration names issuer https://other.example.com, not https://id.example.com",
    );
    await expect(run(oidc, passingChecks({ oidcDiscovery: async () => ({ issuer: "https://id.example.com/" }) }))).resolves.toBeDefined();
  });

  it("recognises a missing endpoint by name or DNS failure", () => {
    expect(endpointMissing(awsError("UnknownEndpoint", "x"))).toBe(true);
    expect(endpointMissing(Object.assign(new Error("x"), { cause: { code: "ENOTFOUND" } }))).toBe(true);
    expect(endpointMissing(awsError("AccessDeniedException", "x"))).toBe(false);
  });
});

// F11: cdkBootstrapped() reads "the parameter was not found" (a bootstrap that has never run) as
// false, and nothing else. A denied or throttled read of the bootstrap parameter is a different
// problem (credentials, permissions, or AWS itself), and must be rethrown with context rather than
// silently reported as "not bootstrapped" (which would send someone off to run cdk bootstrap when
// what they actually need is to fix their credentials).
describe("awsPrerequisiteChecks: cdkBootstrapped (F11)", () => {
  const runner: CommandRunner = { run: async () => ({ stdout: "" }) };
  const unusedFetch: typeof fetch = () => { throw new Error("fetch should not be called by cdkBootstrapped"); };

  it("returns false only when the bootstrap parameter is not found", async () => {
    const checks = awsPrerequisiteChecks({ region: "us-east-1", account: "123456789012", store: new MemoryParameterStore(), runner, fetch: unusedFetch });
    await expect(checks.cdkBootstrapped()).resolves.toBe(false);
  });

  it("returns true when the bootstrap parameter is present", async () => {
    const store = new MemoryParameterStore();
    await store.put("/cdk-bootstrap/hnb659fds/version", "21");
    const checks = awsPrerequisiteChecks({ region: "us-east-1", account: "123456789012", store, runner, fetch: unusedFetch });
    await expect(checks.cdkBootstrapped()).resolves.toBe(true);
  });

  it("rethrows a denied bootstrap-parameter read with context, instead of reporting 'not bootstrapped'", async () => {
    const denied = Object.assign(new Error("AccessDenied: user is not authorized to perform ssm:GetParameter"), { name: "AccessDeniedException" });
    const store: ParameterStore = {
      get: async () => { throw denied; },
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => [],
    };
    const checks = awsPrerequisiteChecks({ region: "us-east-1", account: "123456789012", store, runner, fetch: unusedFetch });
    const error: unknown = await checks.cdkBootstrapped().then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AgentXError);
    expect((error as Error).message).toBe("could not read /cdk-bootstrap/hnb659fds/version in us-east-1: AccessDenied: user is not authorized to perform ssm:GetParameter");
    expect((error as Error).cause).toBe(denied);
  });

  it("rethrows a throttled bootstrap-parameter read the same way", async () => {
    const throttled = Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
    const store: ParameterStore = {
      get: async () => { throw throttled; },
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => [],
    };
    const checks = awsPrerequisiteChecks({ region: "us-east-1", account: "123456789012", store, runner, fetch: unusedFetch });
    await expect(checks.cdkBootstrapped()).rejects.toThrow("could not read /cdk-bootstrap/hnb659fds/version in us-east-1: Rate exceeded");
  });
});
