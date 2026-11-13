// only a developer task that uses the approved environment names its pin, so only its preparation (first or held) may be told a saved image.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, testEnvDigest, type ProjectCommand, type TestEnvironment } from "@rovara-code/contracts";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";
import { projectPk } from "@rovara-code/contracts";
import { heldSavedEnvPin, pinOfStoredPin, pinOfUsedEnvironment, startPreparationOptions } from "../../packages/core/src/core/test-env/saved-env-pin.js";

const cmd = (executable: string, args: string[] = []): ProjectCommand => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const environment = TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "service", setupCommands: [cmd("pip", ["install", "-e", "."])], checks: [{ id: "lint", label: "Lint", command: cmd("ruff", ["check"]), kind: "lint" }] }],
  roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: ["lint"], fullSuiteOn: [] },
  nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
});
const used: TestEnvironment = { revision: 4, approvedAt: "2026-11-02T10:00:00.000Z", environment };
const DIGEST = "a".repeat(64);

describe("the pin a preparation names", () => {
  it("a task that uses the approved environment names its revision and the environment's digest; a task that uses none names nothing", () => {
    expect(pinOfUsedEnvironment(used)).toEqual({ revision: 4, digest: testEnvDigest(environment) });
    expect(pinOfUsedEnvironment(undefined)).toBeUndefined();
  });

  it("a stored pin names its environment only when it was applied", () => {
    expect(pinOfStoredPin({ revision: 4, digest: DIGEST })).toEqual({ revision: 4, digest: DIGEST });
    expect(pinOfStoredPin({ revision: 4, digest: DIGEST, unused: "names_production" as never })).toBeUndefined();
    expect(pinOfStoredPin(undefined)).toBeUndefined();
  });

  it("a task start's preparation options: the pin for an ordinary task; none for a setup draft or an agent-step run (they read only); nothing without a pin", () => {
    const pin = { revision: 4, digest: DIGEST };
    expect(startPreparationOptions({ settingUpDraft: false, agentSteps: undefined, testEnvPin: pin })).toEqual({ testEnvPin: pin });
    expect(startPreparationOptions({ settingUpDraft: false, agentSteps: undefined, testEnvPin: undefined })).toBeUndefined();
    expect(startPreparationOptions({ settingUpDraft: true, agentSteps: undefined, testEnvPin: pin })).toEqual({ readOnly: true, setupDraft: true });
    // a setup agent's run also asks for pins (P1), and still names no pin
    expect(startPreparationOptions({ settingUpDraft: true, pinHeads: true, agentSteps: undefined, testEnvPin: pin })).toEqual({ readOnly: true, setupDraft: true, pinHeads: true });
    expect(startPreparationOptions({ settingUpDraft: false, agentSteps: { checkout: [] }, testEnvPin: pin })).toEqual({ readOnly: true });
    expect(startPreparationOptions({ settingUpDraft: false, agentSteps: { checkout: ["pr"] }, testEnvPin: pin })).toEqual({ checkout: ["pr"], readOnly: true });
  });
});

describe("a held start's dispatch", () => {
  const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
  const pinRow = { orgId: ORG, project: "payments", taskId: "task-1", revision: 4, digest: DIGEST };
  const reading = async (item: Record<string, unknown> | undefined) => {
    const store = new MemoryDocumentStore();
    if (item !== undefined) await store.put({ item: { pk: projectPk(ORG, "payments"), sk: "TESTENV#PIN#task-1", entityType: "TEST_ENV_PIN", ...item } });
    return { store };
  };

  it("uses the pin stored at the task's start", async () => {
    expect(await heldSavedEnvPin(await reading(pinRow), ORG, { project: "payments", taskId: "task-1" })).toEqual({ testEnvPin: { revision: 4, digest: DIGEST } });
  });

  it("names none when the task has no pin, another company's or another task's pin, or a pin for an environment that was not applied", async () => {
    const task = { project: "payments", taskId: "task-1" };
    expect(await heldSavedEnvPin(await reading(undefined), ORG, task)).toEqual({});
    expect(await heldSavedEnvPin(await reading({ ...pinRow, orgId: "org_bbbbbbbbbbbbbbbbbbbb" }), ORG, task)).toEqual({});
    expect(await heldSavedEnvPin(await reading({ ...pinRow, taskId: "task-2" }), ORG, task)).toEqual({});
    expect(await heldSavedEnvPin(await reading({ ...pinRow, unused: "names_production" }), ORG, task)).toEqual({});
  });
});
