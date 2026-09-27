import { describe, expect, it, vi } from "vitest";
import { AgentXError } from "@agentx/contracts";
import {
  awsPrerequisiteChecks,
  checkPrerequisites,
  CONVERSE_CLIENT_MAX_ATTEMPTS,
  CONVERSE_REQUEST_HANDLER_OPTIONS,
  DEDICATED_ACCOUNT_NOTE,
  endpointMissing,
  modelCheckProblem,
  withDeadline,
} from "../../packages/cli/src/init/prerequisites.js";
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
      /init cannot start; nothing was created:\n- this release does not cover region eu-north-1; it covers: us-east-1\n- Amazon Bedrock AgentCore Runtime is not available in eu-north-1 \(or this machine cannot resolve bedrock-agentcore-control\.eu-north-1\.amazonaws\.com; check your network\)/,
    );
  });

  it("counts an AgentCore access denial as the service being present", async () => {
    await expect(run(sampleAnswers(), passingChecks({ agentCore: async () => { throw awsError("AccessDeniedException", "not authorized"); } }))).resolves.toBeDefined();
  });

  it("explains the Anthropic usage form, an id that needs an inference profile, and an unknown id (Review Focus 5)", () => {
    const form = modelCheckProblem({ modelId: "us.anthropic.claude-sonnet-4-6", role: "orchestrator", region: "us-east-1", error: awsError("AccessDeniedException", "Model use case details have not been submitted for this account.") });
    expect(form).toBe(
      "us.anthropic.claude-sonnet-4-6: Anthropic models need a one-time usage form submitted in the Bedrock console. Open the Bedrock console in us-east-1, Model catalog, choose the model and submit the form; submitting it in your organization's management account covers every member account. Then run agentx init again",
    );
    const profile = modelCheckProblem({ modelId: "anthropic.claude-haiku-4-5-20251001-v1:0", role: "classifier", region: "us-east-1", error: awsError("ValidationException", "Invocation of model ID anthropic.claude-haiku-4-5-20251001-v1:0 with on-demand throughput isn't supported.") });
    expect(profile).toBe("anthropic.claude-haiku-4-5-20251001-v1:0 must be called through an inference profile in us-east-1; use us.anthropic.claude-haiku-4-5-20251001-v1:0 instead (--classifier-model)");
    const unknown = modelCheckProblem({ modelId: "made.up-v1", role: "worker", region: "us-east-1", error: awsError("ValidationException", "The provided model identifier is invalid.") });
    expect(unknown).toBe("made.up-v1 is not a Bedrock model id available in us-east-1; check the id, or choose another with --worker-model");
    const denied = modelCheckProblem({ modelId: "zai.glm-4.7", role: "orchestrator", region: "us-east-1", error: awsError("AccessDeniedException", "You don't have access to the model with the specified model ID.") });
    expect(denied).toContain("Your role or an SCP may deny bedrock:InvokeModel for this model");
    expect(denied).toContain("aws-marketplace:Subscribe");
    expect(denied).toContain("Check your permissions, or choose another model with --orchestrator-model");
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
      "the OIDC discovery document at https://id.example.com/.well-known/openid-configuration names issuer https://other.example.com, not https://id.example.com; check --oidc-issuer",
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

// Task 5 fix round 1 (review): items 1-8.
describe("fix round 1", () => {
  // Item 1: Bedrock reports the Anthropic one-time usage-form problem as AccessDeniedException in
  // some accounts and ResourceNotFoundException in others; only the message text tells them apart,
  // so it must be checked before any check on the error name.
  it("item 1: recognises the Anthropic usage-form message the same way whether Bedrock names it AccessDenied or ResourceNotFound", () => {
    const viaAccessDenied = modelCheckProblem({
      modelId: "us.anthropic.claude-sonnet-4-6", role: "orchestrator", region: "us-east-1",
      error: awsError("AccessDeniedException", "Model use case details have not been submitted for this account."),
    });
    const viaResourceNotFound = modelCheckProblem({
      modelId: "us.anthropic.claude-sonnet-4-6", role: "orchestrator", region: "us-east-1",
      error: awsError("ResourceNotFoundException", "Model use case details have not been submitted for this account."),
    });
    expect(viaResourceNotFound).toBe(viaAccessDenied);
    expect(viaAccessDenied).toContain("one-time usage form submitted in the Bedrock console");
    expect(viaAccessDenied).toContain("organization's management account covers every member account");
  });

  // Item 2: the one-token Bedrock call must be bounded so a hung network call fails clearly
  // instead of hanging `agentx init` forever, and the SDK's own retry loop must be off (the
  // outer checkPrerequisites retry already attempts the call at most twice).
  it("item 2: pins the Bedrock client to a single SDK attempt and its own request/connection timeouts", () => {
    expect(CONVERSE_CLIENT_MAX_ATTEMPTS).toBe(1);
    expect(CONVERSE_REQUEST_HANDLER_OPTIONS).toEqual({ requestTimeout: 15_000, connectionTimeout: 5_000 });
  });

  it("item 2: withDeadline rejects with the given message, naming what to try, once the deadline elapses (fake timers, a run() that never resolves)", async () => {
    vi.useFakeTimers();
    try {
      const hang = () => new Promise<never>(() => undefined);
      const message = "us.anthropic.claude-sonnet-4-6 did not answer a one-token test call in us-east-1 within 20s; check your credentials or network, or try again";
      const promise = withDeadline(hang, 20_000, message);
      const assertion = expect(promise).rejects.toThrow(message);
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("item 2: withDeadline aborts the signal it hands to run() once the deadline elapses", async () => {
    vi.useFakeTimers();
    try {
      let seenSignal: AbortSignal | undefined;
      const hang = (signal: AbortSignal) => { seenSignal = signal; return new Promise<never>(() => undefined); };
      const promise = withDeadline(hang, 5_000, "boom");
      const assertion = expect(promise).rejects.toThrow("boom");
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      expect(seenSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("item 2: withDeadline resolves with run()'s own value when it finishes before the deadline", async () => {
    await expect(withDeadline(() => Promise.resolve("ok"), 20_000, "boom")).resolves.toBe("ok");
  });

  // Item 3: the OIDC discovery fetch is bounded, parses JSON itself, and every failure names the
  // issuer and says to check --oidc-issuer. Tested through the injected fetch, so no real network
  // or fake timers are needed (a fake fetch can just reject the way a real timeout would).
  describe("item 3: awsPrerequisiteChecks().oidcDiscovery", () => {
    const runner: CommandRunner = { run: async () => ({ stdout: "" }) };
    const checksWith = (mockFetch: typeof fetch) => awsPrerequisiteChecks({ region: "us-east-1", account: "123456789012", store: new MemoryParameterStore(), runner, fetch: mockFetch });

    it("maps a non-ok HTTP status", async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 503 }));
      await expect(checksWith(fetch).oidcDiscovery("https://id.example.com")).rejects.toThrow(
        "the OIDC discovery document at https://id.example.com/.well-known/openid-configuration answered HTTP 503; check --oidc-issuer",
      );
    });

    it("maps a non-JSON body", async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("<html>not json</html>", { status: 200 }));
      await expect(checksWith(fetch).oidcDiscovery("https://id.example.com")).rejects.toThrow(
        "the OIDC discovery document at https://id.example.com/.well-known/openid-configuration is not valid JSON; check --oidc-issuer",
      );
    });

    it("maps a timeout", async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); });
      await expect(checksWith(fetch).oidcDiscovery("https://id.example.com")).rejects.toThrow(
        "could not reach the OIDC discovery document at https://id.example.com/.well-known/openid-configuration (did not answer within 10s); check --oidc-issuer",
      );
    });

    it("returns the parsed document when it answers 200 with JSON", async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ issuer: "https://id.example.com" }), { status: 200 }));
      await expect(checksWith(fetch).oidcDiscovery("https://id.example.com")).resolves.toEqual({ issuer: "https://id.example.com" });
    });
  });

  // Item 4: a failed read of the bootstrap parameter (anything other than "not bootstrapped") must
  // not abort the whole run early; it is one more collected problem, and every other check still
  // runs and is still reported.
  it("item 4: a failed CDK-bootstrap check is one more collected problem, not an early abort", async () => {
    const lines: string[] = [];
    const checks = passingChecks({ cdkBootstrapped: async () => { throw new Error("AccessDenied: user is not authorized to perform ssm:GetParameter"); } });
    await expect(checkPrerequisites({
      answers: sampleAnswers({ engine: "cdk" }),
      releaseRegions: ["us-east-1"],
      caller,
      checks,
      prompter: scriptedPrompter([]),
      write: (line) => lines.push(line),
    })).rejects.toThrow("could not check CDK bootstrap: AccessDenied: user is not authorized to perform ssm:GetParameter; check your credentials can read SSM");
    // every other check still ran (and would have reported its own problems alongside this one):
    expect(lines).toContain(`ok ${sampleAnswers().models.orchestrator} answers`);
    expect(checks.bootstraps).toBe(0);
  });

  it("item 4: reports a failed CDK-bootstrap check alongside every other problem, in order", async () => {
    const checks = passingChecks({
      cdkBootstrapped: async () => { throw new Error("Rate exceeded"); },
      converse: async (id) => { throw awsError("ValidationException", `The provided model identifier is invalid. ${id}`); },
    });
    await expect(run(sampleAnswers({ engine: "cdk", models: { orchestrator: "x", classifier: "y", worker: "z" } }), checks, scriptedPrompter([]))).rejects.toThrow(
      /- x is not a Bedrock model id.*\n- y is not a Bedrock model id.*\n- z is not a Bedrock model id.*\n- could not check CDK bootstrap: Rate exceeded; check your credentials can read SSM/s,
    );
  });

  // Item 5: the AgentCore-unreachable-by-DNS message names the exact hostname and says to check
  // the network (already covered end-to-end above); this adds a direct assertion on the wording.
  it("item 5: names the unresolved AgentCore hostname and says to check the network", async () => {
    const checks = passingChecks({ agentCore: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND bedrock-agentcore-control.ap-south-2.amazonaws.com"), { code: "ENOTFOUND" }); } });
    await expect(run(sampleAnswers({ region: "ap-south-2" }), checks)).rejects.toThrow(
      "Amazon Bedrock AgentCore Runtime is not available in ap-south-2 (or this machine cannot resolve bedrock-agentcore-control.ap-south-2.amazonaws.com; check your network)",
    );
  });

  // Item 6: every message names a next step. AgentCore-unreachable-for-some-other-reason, a model
  // giving no answer at all, and "Bedrock not available in this region" (a model-check-level
  // endpoint failure, distinct from the AgentCore-level one above) were the three left silent.
  it("item 6: an unexplained AgentCore failure still says what to check", async () => {
    const checks = passingChecks({ agentCore: async () => { throw new Error("socket hang up"); } });
    await expect(run(sampleAnswers(), checks)).rejects.toThrow(
      "could not reach AgentCore Runtime in us-east-1: socket hang up; check your credentials or network, or choose another region with --region",
    );
  });

  it("item 6: a model that gives no answer at all still says what to check", () => {
    const problem = modelCheckProblem({ modelId: "made.up-v2", role: "worker", region: "us-east-1", error: new Error("socket hang up") });
    expect(problem).toBe("made.up-v2 did not answer a one-token test call in us-east-1: socket hang up; check your credentials or network, or choose another model with --worker-model");
  });

  it("item 6: Bedrock not available in the region (model check) says to choose another region", () => {
    const problem = modelCheckProblem({
      modelId: "amazon.nova-lite-v1:0", role: "classifier", region: "eu-north-1",
      error: Object.assign(new Error("getaddrinfo ENOTFOUND bedrock-runtime.eu-north-1.amazonaws.com"), { code: "ENOTFOUND" }),
    });
    expect(problem).toBe("Amazon Bedrock is not available in eu-north-1; choose another region with --region");
  });

  // Item 7: AWS retired the Bedrock console's "Model access" page (What's New, October 2025);
  // serverless models are enabled automatically in commercial regions, so a plain AccessDenied for
  // a non-Anthropic model now means the role or an SCP denies bedrock:InvokeModel, or (for a
  // Marketplace model) the role is missing aws-marketplace:Subscribe.
  it("item 7: an access denial for a non-Anthropic model points at bedrock:InvokeModel, SCPs and Marketplace subscribe", () => {
    const problem = modelCheckProblem({ modelId: "zai.glm-4.7", role: "orchestrator", region: "us-east-1", error: awsError("AccessDeniedException", "You don't have access to the model with the specified model ID.") });
    expect(problem).not.toContain("Model access");
    expect(problem).not.toContain("Enable access in the Bedrock console");
    expect(problem).toContain("bedrock:InvokeModel");
    expect(problem).toContain("aws-marketplace:Subscribe");
    expect(problem).toContain("choose another model with --orchestrator-model");
  });

  // Item 8: us-gov- regions get the us-gov. inference-profile prefix; ca- and sa- regions have no
  // reliable prefix to guess, so the advice sends the person to the console instead of a wrong id.
  it("item 8: us-gov- regions get the us-gov. inference-profile prefix", () => {
    const problem = modelCheckProblem({
      modelId: "anthropic.claude-haiku-4-5-20251001-v1:0", role: "classifier", region: "us-gov-west-1",
      error: awsError("ValidationException", "Invocation of model ID anthropic.claude-haiku-4-5-20251001-v1:0 with on-demand throughput isn't supported."),
    });
    expect(problem).toBe(
      "anthropic.claude-haiku-4-5-20251001-v1:0 must be called through an inference profile in us-gov-west-1; use us-gov.anthropic.claude-haiku-4-5-20251001-v1:0 instead (--classifier-model)",
    );
  });

  it("item 8: ca- and sa- regions cannot be guessed, so init points at the Bedrock console instead", () => {
    const onDemandError = awsError("ValidationException", "Invocation of model ID anthropic.claude-haiku-4-5-20251001-v1:0 with on-demand throughput isn't supported.");
    const ca = modelCheckProblem({ modelId: "anthropic.claude-haiku-4-5-20251001-v1:0", role: "worker", region: "ca-central-1", error: onDemandError });
    expect(ca).toBe(
      "anthropic.claude-haiku-4-5-20251001-v1:0 must be called through an inference profile in ca-central-1; use the inference profile id listed in the Bedrock console for ca-central-1 instead (--worker-model)",
    );
    const sa = modelCheckProblem({ modelId: "anthropic.claude-haiku-4-5-20251001-v1:0", role: "worker", region: "sa-east-1", error: onDemandError });
    expect(sa).toBe(
      "anthropic.claude-haiku-4-5-20251001-v1:0 must be called through an inference profile in sa-east-1; use the inference profile id listed in the Bedrock console for sa-east-1 instead (--worker-model)",
    );
  });
});
