import { describe, expect, it } from "vitest";
import { MissingProviderSecret } from "../../packages/model-runtime/src/config.js";
import { modelChecks } from "../../packages/cli/src/doctor/account.js";
import { doctorContext, doctorServices, healthyStacks, SETTINGS } from "../support/doctor-fakes.js";
import { passingChecks } from "../support/init-fakes.js";

// M1.4 Task 4.10D, test 41 (MODEL3): doctor reports a missing provider secret as an error naming the role, and says whether a fallback was chosen.

const openai = { ...SETTINGS, models: { ...SETTINGS.models, worker: "gpt-5.4", providers: { worker: "openai" as const } } };
const missing = passingChecks({ directProvider: async (provider) => { throw new MissingProviderSecret(provider); } });

describe("doctor: a missing provider secret", () => {
  it("is an error naming the role and the provider, and says no fallback was chosen", async () => {
    const worker = (await modelChecks(doctorContext({ settings: openai, services: doctorServices({ checks: missing }) }))).find((entry) => entry.name === "worker")!;
    expect(worker.status).toBe("fail");
    expect(worker.detail).toBe("the OpenAI key secret for the worker model gpt-5.4 is missing, and no fallback model was chosen: the worker's tasks fail by name until the key is restored");
    expect(worker.fix).toBe("restore the key, or choose a fallback with agentx --env staging config set models.fallback <bedrock model id>");
  });

  it("names the chosen fallback when the runtime stack has one, and is still an error", async () => {
    const stacks = healthyStacks();
    const runtime = stacks["agentx-staging-runtime"]!;
    stacks["agentx-staging-runtime"] = { ...runtime, parameters: { ...runtime.parameters, ModelFallback: "us.anthropic.claude-sonnet-4-6" } };
    const worker = (await modelChecks(doctorContext({ settings: openai, services: doctorServices({ checks: missing, stackMap: stacks }) }))).find((entry) => entry.name === "worker")!;
    expect(worker.status).toBe("fail");
    expect(worker.detail).toBe("the OpenAI key secret for the worker model gpt-5.4 is missing: its tasks run on Amazon Bedrock us.anthropic.claude-sonnet-4-6 (models.fallback) until the key is restored");
  });
});
