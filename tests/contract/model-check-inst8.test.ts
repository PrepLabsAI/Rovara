import { describe, expect, it } from "vitest";
import type { QuotaClient } from "../../packages/model-runtime/src/model-discovery.js";
import { modelChecks } from "../../packages/cli/src/doctor/account.js";
import { runConfigSet } from "../../packages/cli/src/config/commands.js";
import { checkPrerequisites } from "../../packages/cli/src/init/prerequisites.js";
import { doctorContext, doctorServices, SETTINGS } from "../support/doctor-fakes.js";
import { services as configServices, seeded } from "../support/config-services.js";
import { fakeRelease, passingChecks, sampleAnswers, scriptedPrompter } from "../support/init-fakes.js";
import { fakeCloudFormation } from "../support/fake-cloudformation.js";

// M1.4 Task 4.10D, test 42 (INST-8): after the second ThrottlingException the role's model quota is read, and a zero is a limit, never "wait a minute". Init, doctor and config set use the same text.

const SONNET = "us.anthropic.claude-sonnet-4-6";
const throttled = () => Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException", $metadata: { httpStatusCode: 429 } });
const quotas = (value: number): QuotaClient => ({ list: async () => ({ quotas: [{ code: "L-SONNET46GEO", name: "Cross-region model inference tokens per minute for Anthropic Claude Sonnet 4.6", value }] }) });
const denied: QuotaClient = { list: async () => { throw Object.assign(new Error("not allowed"), { name: "AccessDeniedException" }); } };
const caller = { account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/Admin/alice" };

async function init(client: QuotaClient | undefined): Promise<{ calls: number; message: string }> {
  let calls = 0;
  const checks = passingChecks({ converse: async () => { calls += 1; throw throttled(); }, ...(client === undefined ? {} : { quotas: client }) });
  const answers = sampleAnswers({ models: { orchestrator: SONNET, classifier: SONNET, worker: SONNET } });
  const message = await checkPrerequisites({ answers, release: fakeRelease(), caller, checks, prompter: scriptedPrompter([]), write: () => undefined }).then(() => "", (error: Error) => error.message);
  return { calls, message };
}

describe("INST-8 in init", () => {
  it("reads a zero quota as a limit with the quota's code, after exactly two tries, and does not say 'wait a minute'", async () => {
    const { calls, message } = await init(quotas(0));
    expect(calls).toBe(2);
    expect(message).toContain(`Amazon Bedrock's limit for ${SONNET} in this account is 0 tokens per minute (quota L-SONNET46GEO). Request an increase in Service Quotas, or choose another model with --orchestrator-model`);
    expect(message).not.toContain("wait a minute");
  });

  it("names the quota and its value above zero with 'if this repeats'", async () => {
    expect((await init(quotas(5_000_000))).message).toContain("if this repeats, check Service Quotas → Amazon Bedrock (quota L-SONNET46GEO: 5000000 tokens per minute)");
  });

  it("keeps today's text and says the quota could not be read when the lookup is denied", async () => {
    const { message } = await init(denied);
    expect(message).toContain(`Bedrock throttled the check of ${SONNET}; wait a minute and run agentx init again`);
    expect(message).toContain("Rovara could not read the quota");
  });
});

describe("INST-8 in doctor", () => {
  const sonnetOnly = { ...SETTINGS, models: { ...SETTINGS.models, orchestrator: SONNET, classifier: SONNET, worker: SONNET } };
  const found = async (client: QuotaClient) => (await modelChecks(doctorContext({ settings: sonnetOnly, services: doctorServices({ checks: passingChecks({ converse: async () => { throw throttled(); }, quotas: client }) }) }))).find((entry) => entry.name === "orchestrator")!;

  it("uses the same limit text, worded for doctor", async () => {
    const orchestrator = await found(quotas(0));
    expect(orchestrator.status).toBe("fail");
    expect(orchestrator.detail).toContain("is 0 tokens per minute (quota L-SONNET46GEO). Request an increase in Service Quotas, or choose another model with agentx --env staging config set models.orchestrator <model id>");
    expect(orchestrator.detail).not.toContain("wait a minute");
  });

  it("says 'if this repeats' above zero, and the old text with 'could not read the quota' when denied", async () => {
    expect((await found(quotas(5_000_000))).detail).toContain("quota L-SONNET46GEO: 5000000 tokens per minute");
    const unreadable = (await found(denied)).detail;
    expect(unreadable).toContain("wait a minute and run agentx doctor again");
    expect(unreadable).toContain("could not read the quota");
  });
});

describe("INST-8 in config set", () => {
  it("reads a zero quota as a limit and changes nothing", async () => {
    const store = await seeded();
    const opus: QuotaClient = { list: async () => ({ quotas: [{ code: "L-OPUS41GEO", name: "Cross-region model inference tokens per minute for Anthropic Claude Opus 4.1", value: 0 }] }) };
    const checks = passingChecks({ converse: async () => { throw throttled(); }, quotas: opus });
    const error = await runConfigSet(configServices({ store, cloudFormation: fakeCloudFormation(), checks: () => checks }), "staging", { key: "models.worker", value: "us.anthropic.claude-opus-4-1-20250805-v1:0", yes: true }).then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.message).toContain("is 0 tokens per minute (quota L-OPUS41GEO)");
    expect(error?.message).toContain("nothing changed");
    expect(error?.message).not.toContain("wait a minute");
  });
});
