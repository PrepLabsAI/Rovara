// The init fixtures must preserve browser traffic and report exhausted scripts without waiting
// for the install's unanswered question. These checks use in-memory HTTP responses, no listener.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertGatewayRunPrices } from "../../packages/cli/src/deploy/gateway-price-preflight.js";
import { browserPrompter } from "../../packages/cli/src/init/ui/prompter.js";
import { createWizardHub } from "../../packages/cli/src/init/ui/state.js";
import { installGatewayFixture, readyCoreEngine } from "../support/install-gateway.js";
import { scriptedPrompter, settingsScript } from "../support/init-fakes.js";
import { collectInitAnswers } from "../../packages/cli/src/init/answers.js";
import { fakeWizardOperator, runWithWizardErrors } from "../support/wizard-browser.js";
import { lintCopy, stateEntries } from "../support/copy-lint.js";

afterEach(() => vi.unstubAllGlobals());

describe("the install gateway fixture", () => {
  beforeEach(() => vi.stubGlobal("fetch", async () => new Response("local browser response")));
  installGatewayFixture();

  it("serves the signed-price readiness response at the configured health URL", async () => {
    await expect(assertGatewayRunPrices(readyCoreEngine.modelGatewayUrl)).resolves.toBeUndefined();
  });

  it.each([
    "http://127.0.0.1:1234/events",
    new URL("http://127.0.0.1:1234/github/start"),
    new Request("http://127.0.0.1:1234/answer", { method: "POST", body: "answer" }),
  ])("preserves the browser transport for %s", async (target) => {
    expect(await (await fetch(target)).text()).toBe("local browser response");
  });

  it.each(["https://gateway.example/other", "https://other.example/healthz"])("refuses an unconfigured target %s without fetching it", async (target) => {
    await expect(fetch(target)).rejects.toThrow("test setup: unexpected fetch target");
  });
});

it("the terminal settings script answers the required core-engine pair and exhausts exactly", async () => {
  const prompter = scriptedPrompter(settingsScript());
  const { answers } = await collectInitAnswers({ env: "staging", region: "us-east-1", account: "123456789012", releaseVersion: "1.2.3", flags: {}, prompter, ownerType: async () => "organization", processEnv: {}, now: () => 0 });
  expect(answers.coreEngine).toEqual({ modelGatewayUrl: "https://gateway.example", agentModel: "claude-sonnet-4-6" });
  expect(prompter.remaining()).toBe(0);
  await expect(prompter.ask("Unexpected question", { flag: "--unexpected" })).rejects.toThrow('no scripted answer for "Unexpected question"');
});

it("the page requires the approved gateway questions in order and keeps their copy plain", async () => {
  const hub = createWizardHub("staging");
  const collected = collectInitAnswers({ env: "staging", region: "us-east-1", account: "123456789012", releaseVersion: "1.2.3", flags: {}, prompter: browserPrompter(hub), ownerType: async () => "organization", processEnv: {}, now: () => 0 });
  try {
    const form = hub.state().question;
    if (form === undefined) throw new Error("test setup: no settings form");
    expect(form.fields?.filter((field) => ["modelGatewayUrl", "agentModel"].includes(field.name)).map((field) => field.label)).toEqual(["Signed-price model gateway URL", "Core agent model"]);
    expect(lintCopy(stateEntries(hub.state(), "settings"))).toEqual([]);
    const values = { email: "ops@example.com", githubAccount: "acme" };
    expect(hub.answer(form.id, JSON.stringify(values))).toBeDefined();
    const corrected = hub.state().question;
    if (corrected === undefined) throw new Error("test setup: no corrected settings form");
    expect(hub.answer(corrected.id, JSON.stringify({ ...values, modelGatewayUrl: "https://gateway.example", agentModel: "claude-sonnet-4-6" }))).toBeUndefined();
    expect((await collected).answers.coreEngine).toEqual({ modelGatewayUrl: "https://gateway.example", agentModel: "claude-sonnet-4-6" });
  } finally {
    hub.close();
    await collected.catch(() => undefined);
  }
});

it("the wizard reports a missing scripted answer while the install still awaits that answer", async () => {
  const hub = createWizardHub("staging");
  const waiting = browserPrompter(hub).ask("Core agent model", { flag: "--agent-model" });
  vi.stubGlobal("fetch", async () => new Response(`event: snapshot\ndata: ${JSON.stringify(hub.snapshot())}\n\n`));
  const operator = fakeWizardOperator([]);
  await operator.open("http://127.0.0.1:1234/?t=test");
  try {
    await expect(runWithWizardErrors(operator.open, () => waiting)).rejects.toThrow('no scripted answer for "Core agent model"');
    await expect(operator.settled()).rejects.toThrow('no scripted answer for "Core agent model"');
  } finally {
    hub.close();
    await waiting.catch(() => undefined);
  }
});
