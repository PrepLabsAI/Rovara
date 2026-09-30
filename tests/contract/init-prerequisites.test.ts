import { MissingOpenRouterSecret, DEFAULT_BEDROCK_MODELS } from "@agentx/model-runtime/config";
import { describe, expect, it, vi } from "vitest";
import { AgentXError } from "@agentx/contracts";
import { EC2Client, type DescribeAddressesCommand } from "@aws-sdk/client-ec2";
import { ServiceQuotasClient, type GetServiceQuotaCommand } from "@aws-sdk/client-service-quotas";
import {
  awsPrerequisiteChecks,
  checkPrerequisites,
  CONVERSE_CLIENT_MAX_ATTEMPTS,
  CONVERSE_REQUEST_HANDLER_OPTIONS,
  DEDICATED_ACCOUNT_NOTE,
  endpointMissing,
  modelCheckProblem,
  NAT_ELASTIC_IPS,
  type PrerequisiteCheck,
  withDeadline,
} from "../../packages/cli/src/init/prerequisites.js";
import type { InitAnswers } from "../../packages/cli/src/init/install-state.js";
import type { ParameterStore } from "../../packages/cli/src/environments/parameter-store.js";
import type { CommandRunner } from "../../packages/cli/src/deploy/cdk-engine.js";
import { fakeRelease, passingChecks, sampleAnswers, scriptedPrompter } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const caller = { account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/Admin/alice" };
const awsError = (name: string, message: string) => Object.assign(new Error(message), { name });

async function run(answers: InitAnswers, checks = passingChecks(), prompter = scriptedPrompter([])) {
  const lines: string[] = [];
  await checkPrerequisites({ answers, release: fakeRelease(), caller, checks, prompter, write: (line) => lines.push(line) });
  return lines;
}

describe("init prerequisites", () => {
  it("checks each distinct fallback when the same missing-credential OpenRouter model is selected", async () => {
    const checks = passingChecks();
    const model = "qwen/qwen3-coder";
    await run(sampleAnswers({ models: { orchestrator: model, classifier: model, worker: model,
      providers: { orchestrator: "openrouter", classifier: "openrouter", worker: "openrouter" },
    } }), checks);
    expect(checks.models).toEqual([...new Set([DEFAULT_BEDROCK_MODELS.orchestrator, DEFAULT_BEDROCK_MODELS.classifier, DEFAULT_BEDROCK_MODELS.worker])]);
  });
  it("checks and reports the default Bedrock model when the OpenRouter secret is absent", async () => {
    for (const openRouter of [undefined, { secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:missing-AbCdEf" }]) {
      const checks = passingChecks({ openRouter: async () => { throw new MissingOpenRouterSecret(); } });
      const answers = sampleAnswers({ models: { orchestrator: "a", classifier: "b", worker: "qwen/qwen3-coder",
        providers: { worker: "openrouter" }, ...(openRouter ? { openRouter } : {}),
      } });
      const lines = await run(answers, checks);
      expect(checks.models).toContain(DEFAULT_BEDROCK_MODELS.worker);
      expect(lines.join("\n")).toContain("OpenRouter secret missing; using default amazon-bedrock/");
    }
  });
  it("checks OpenRouter independently and never invokes Bedrock for OpenRouter roles", async () => {
    const openRouter = vi.fn(async () => {});
    const checks = passingChecks({ openRouter });
    const model = "anthropic/claude-sonnet-4";
    await run(sampleAnswers({ models: { orchestrator: model, classifier: model, worker: model,
      providers: { orchestrator: "openrouter", classifier: "openrouter", worker: "openrouter" },
      openRouter: { secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:openrouter-AbCdEf" },
    } }), checks);
    expect(checks.models).toEqual([]);
    expect(openRouter).toHaveBeenCalledTimes(1);
  });

  it("checks OpenRouter with the key init collected but has not stored yet, instead of falling back to Bedrock", async () => {
    const openRouter = vi.fn(async () => {});
    const checks = passingChecks({ openRouter });
    const model = "qwen/qwen3-coder";
    const answers = sampleAnswers({ models: { orchestrator: model, classifier: model, worker: model,
      providers: { orchestrator: "openrouter", classifier: "openrouter", worker: "openrouter" },
    } });
    const lines: string[] = [];
    await checkPrerequisites({ answers, release: fakeRelease(), caller, checks, prompter: scriptedPrompter([]), write: (line) => lines.push(line),
      openRouterKey: { key: "sk-or-v1-pending-key-value", providers: ["deepinfra/turbo"] } });
    expect(checks.models).toEqual([]);
    expect(openRouter).toHaveBeenCalledTimes(1);
    expect(openRouter).toHaveBeenCalledWith(model, { providers: ["deepinfra/turbo"] }, "sk-or-v1-pending-key-value");
    expect(lines.join("\n")).not.toContain("sk-or-v1-pending-key-value");
    expect(lines.join("\n")).toContain("ok openrouter/qwen/qwen3-coder supports tools and answers");
  });

  it("awsPrerequisiteChecks().openRouter sends a supplied key without reading any secret", async () => {
    const seen: string[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.push(`${url} ${new Headers(init?.headers).get("Authorization") ?? ""}`);
      const body = url.endsWith("/models")
        ? { data: [{ id: "qwen/qwen3-coder", supported_parameters: ["tools"] }] }
        : { choices: [{ message: { content: "OK" } }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const checks = awsPrerequisiteChecks({ region: "us-east-1", account: "123456789012", store: new MemoryParameterStore(), runner: { run: async () => ({ stdout: "", stderr: "" }) }, fetch: fakeFetch });
    await checks.openRouter?.("qwen/qwen3-coder", {}, "sk-or-v1-pending-key-value");
    expect(seen).toEqual([
      "https://openrouter.ai/api/v1/models Bearer sk-or-v1-pending-key-value",
      "https://openrouter.ai/api/v1/chat/completions Bearer sk-or-v1-pending-key-value",
    ]);
  });

  it("does not print upstream errors or credentials when OpenRouter preflight fails", async () => {
    const checks = passingChecks({ openRouter: async () => { throw new Error("sk-secret and private prompt"); } });
    const answers = sampleAnswers({ models: { orchestrator: "model", classifier: "model", worker: "model",
      providers: { worker: "openrouter" }, openRouter: { secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:openrouter-AbCdEf" },
    } });
    await expect(run(answers, checks)).rejects.toThrow("OpenRouter preflight failed");
    await expect(run(answers, checks)).rejects.not.toThrow("sk-secret");
  });
  it("names the account, recommends a dedicated account, and checks each distinct model once", async () => {
    const checks = passingChecks();
    const lines = await run(sampleAnswers({ models: { orchestrator: "a", classifier: "b", worker: "a" } }), checks);
    expect(lines[0]).toBe("AWS account 123456789012 as arn:aws:sts::123456789012:assumed-role/Admin/alice");
    expect(lines).toContain(DEDICATED_ACCOUNT_NOTE);
    expect(checks.models).toEqual(["a", "b"]);
  });

  it("refuses insufficient EC2 quota before creating anything", async () => {
    for (const quota of [0, NaN]) {
      await expect(run(sampleAnswers(), passingChecks({ ec2Quota: async () => quota })))
        .rejects.toThrow(/vCPU quota.*at least 1/);
    }
  });

  it("refuses up front when the region has too few Elastic IPs left for the NAT gateways", async () => {
    const error = await run(sampleAnswers(), passingChecks({ elasticIps: async () => ({ quota: 5, allocated: 4 }) })).catch((caught: unknown) => caught);
    expect(String(error)).toContain(`needs ${NAT_ELASTIC_IPS} Elastic IPs for its NAT gateways, but 4 of the 5 allowed`);
    expect(String(error)).toContain("L-0263D0A3");
    expect(String(error)).toContain("aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-0263D0A3 --desired-value 6 --region us-east-1");
  });

  it("passes when exactly enough Elastic IPs are left, and says how many", async () => {
    const lines = await run(sampleAnswers(), passingChecks({ elasticIps: async () => ({ quota: 5, allocated: 3 }) }));
    expect(lines).toContain("ok 2 of 5 EC2-VPC Elastic IPs free in us-east-1; this environment needs 2");
  });

  it("reports an Elastic IP quota or count it cannot read as a problem, never as a pass", async () => {
    for (const reading of [{ quota: Number.NaN, allocated: 0 }, { quota: 5, allocated: Number.NaN }]) {
      await expect(run(sampleAnswers(), passingChecks({ elasticIps: async () => reading })))
        .rejects.toThrow(/could not check Elastic IPs in us-east-1: .*did not return a number/);
    }
  });

  it("awsPrerequisiteChecks().elasticIps reads quota L-0263D0A3 and counts only VPC addresses", async () => {
    const quotaSend = vi.spyOn(ServiceQuotasClient.prototype, "send").mockResolvedValue({ Quota: { Value: 5 } } as never);
    const ec2Send = vi.spyOn(EC2Client.prototype, "send").mockResolvedValue({ Addresses: [{}, {}, {}] } as never);
    try {
      const checks = awsPrerequisiteChecks({ region: "us-east-1", account: "123456789012", store: new MemoryParameterStore(), runner: { run: async () => ({ stdout: "", stderr: "" }) }, fetch: async () => { throw new Error("unused"); } });
      expect(await checks.elasticIps()).toEqual({ quota: 5, allocated: 3 });
      expect((quotaSend.mock.calls[0]![0] as GetServiceQuotaCommand).input).toEqual({ ServiceCode: "ec2", QuotaCode: "L-0263D0A3" });
      expect((ec2Send.mock.calls[0]![0] as DescribeAddressesCommand).input).toEqual({ Filters: [{ Name: "domain", Values: ["vpc"] }] });
    } finally {
      quotaSend.mockRestore();
      ec2Send.mockRestore();
    }
  });

  it("awsPrerequisiteChecks().elasticIps refuses a quota response with no value instead of reading it as 0", async () => {
    const quotaSend = vi.spyOn(ServiceQuotasClient.prototype, "send").mockResolvedValue({ Quota: {} } as never);
    const ec2Send = vi.spyOn(EC2Client.prototype, "send").mockResolvedValue({ Addresses: [] } as never);
    try {
      const checks = awsPrerequisiteChecks({ region: "us-east-1", account: "123456789012", store: new MemoryParameterStore(), runner: { run: async () => ({ stdout: "", stderr: "" }) }, fetch: async () => { throw new Error("unused"); } });
      await expect(checks.elasticIps()).rejects.toThrow("the Elastic IP quota L-0263D0A3 did not return a number");
    } finally {
      quotaSend.mockRestore();
      ec2Send.mockRestore();
    }
  });

  it("refuses an unreadable Elastic IP count and reports a remedy", async () => {
    await expect(run(sampleAnswers(), passingChecks({ elasticIps: async () => { throw awsError("UnauthorizedOperation", "not authorized"); } })))
      .rejects.toThrow(/could not check Elastic IPs in us-east-1: .*check EC2 DescribeAddresses and Service Quotas read permission/);
  });

  it("refuses an unreadable quota and reports a remedy", async () => {
    await expect(run(sampleAnswers(), passingChecks({ ec2Quota: async () => { throw awsError("AccessDeniedException", "not authorized"); } })))
      .rejects.toThrow(/check Service Quotas read permission/);
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
      release: fakeRelease(),
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

  // Item 5: the EC2 quota-unreachable-by-DNS message names the exact hostname and says to check
  // the network (already covered end-to-end above); this adds a direct assertion on the wording.
  it("item 5: names the unresolved EC2 quota hostname and says to check the network", async () => {
    const checks = passingChecks({ ec2Quota: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND servicequotas.ap-south-2.amazonaws.com"), { code: "ENOTFOUND" }); } });
    await expect(run(sampleAnswers({ region: "ap-south-2" }), checks)).rejects.toThrow(
      "could not check EC2 vCPU quota in ap-south-2: getaddrinfo ENOTFOUND servicequotas.ap-south-2.amazonaws.com; check Service Quotas read permission and your network",
    );
  });

  // Item 6: every message names a next step. EC2 quota-unreachable-for-some-other-reason, a model
  // giving no answer at all, and "Bedrock not available in this region" (a model-check-level
  // endpoint failure, distinct from the EC2 quota-level one above) were the three left silent.
  it("item 6: an unexplained EC2 quota failure still says what to check", async () => {
    const checks = passingChecks({ ec2Quota: async () => { throw new Error("socket hang up"); } });
    await expect(run(sampleAnswers(), checks)).rejects.toThrow(
      "could not check EC2 vCPU quota in us-east-1: socket hang up; check Service Quotas read permission and your network",
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

describe("the prerequisite checklist (spec 040 FR-023)", () => {
  const run = (checks: ReturnType<typeof passingChecks>, onCheck?: (check: PrerequisiteCheck) => void) => {
    const lines: string[] = [];
    const done = checkPrerequisites({
      answers: sampleAnswers(), release: fakeRelease(), caller: { account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/Admin/alice" },
      checks, prompter: scriptedPrompter([]), write: (line) => { lines.push(line); }, ...(onCheck === undefined ? {} : { onCheck }),
    });
    return { lines, done };
  };

  it("reports each check as it finishes, and writes exactly the lines it wrote before", async () => {
    const reported: PrerequisiteCheck[] = [];
    const withList = run(passingChecks(), (check) => { reported.push(check); });
    await withList.done;
    const without = run(passingChecks());
    await without.done;
    expect(withList.lines).toEqual(without.lines);
    expect(reported.map((check) => [check.label, check.ok])).toEqual([
      ["Region", true], ["EC2 vCPU quota", true], ["Elastic IPs", true],
      ...[...new Set([sampleAnswers().models.orchestrator, sampleAnswers().models.classifier, sampleAnswers().models.worker])].map((model) => [`Model ${model}`, true]),
    ]);
    expect(reported[1]).toEqual({ label: "EC2 vCPU quota", ok: true, detail: "EC2 Standard on-demand vCPU quota is 32 in us-east-1" });
  });

  it("reports passing Node, npx and CDK bootstrap checks for the cdk engine, and still writes no line for them", async () => {
    const lists = async (onCheck?: (check: PrerequisiteCheck) => void) => {
      const lines: string[] = [];
      await checkPrerequisites({
        answers: sampleAnswers({ engine: "cdk" }), release: fakeRelease(), caller: { account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/Admin/alice" },
        checks: passingChecks(), prompter: scriptedPrompter([]), write: (line) => { lines.push(line); }, ...(onCheck === undefined ? {} : { onCheck }),
      });
      return lines;
    };
    const reported: PrerequisiteCheck[] = [];
    const withList = await lists((check) => { reported.push(check); });
    expect(withList).toEqual(await lists());
    expect(reported.slice(-3)).toEqual([
      { label: "Node", ok: true, detail: "Node v22.20.0" },
      { label: "npx", ok: true, detail: "npx 10.9.0" },
      { label: "CDK bootstrap", ok: true, detail: "CDK is bootstrapped in us-east-1" },
    ]);
  });

  it("never reports a failing page callback as a CDK bootstrap read failure", async () => {
    const onCheck = (check: PrerequisiteCheck) => { if (check.label === "CDK bootstrap" && check.ok) throw new Error("the page's card could not be drawn"); };
    const done = checkPrerequisites({
      answers: sampleAnswers({ engine: "cdk" }), release: fakeRelease(), caller: { account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/Admin/alice" },
      checks: passingChecks(), prompter: scriptedPrompter([]), write: () => undefined, onCheck,
    });
    const message = await done.then(() => "resolved", (error: unknown) => (error as Error).message);
    expect(message).toBe("the page's card could not be drawn");
  });

  it("reports a failed check with the same words the error lists", async () => {
    const reported: PrerequisiteCheck[] = [];
    const { done } = run(passingChecks({ ec2Quota: async () => 0 }), (check) => { reported.push(check); });
    await expect(done).rejects.toThrow("EC2 Standard on-demand vCPU quota in us-east-1 must be at least 1");
    expect(reported.find((check) => check.label === "EC2 vCPU quota")).toEqual({
      label: "EC2 vCPU quota", ok: false, detail: "EC2 Standard on-demand vCPU quota in us-east-1 must be at least 1 for an m6g.medium worker; request an increase in Service Quotas",
    });
  });
});
