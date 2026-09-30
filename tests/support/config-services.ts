// tests/support/config-services.ts
// The agentx config command's services with every AWS client faked: a staging environment's
// settings seeded in memory, its stacks' parameters, and a scripted prompter. Shared by the config
// contract tests (moved here from config-commands.test.ts for spec 025 phase 25e's limits test).
import type { ConfigServices } from "../../packages/cli/src/config/commands.js";
import type { StackDescription } from "../../packages/cli/src/environments/adopt.js";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { fakeCloudFormation } from "./fake-cloudformation.js";
import { memoryInitSecrets, passingChecks, scriptedPrompter, T0 } from "./init-fakes.js";
import { MemoryParameterStore } from "./memory-parameter-store.js";
import { fakeAlerts, STAGING_SETTINGS } from "./setup-fakes.js";

export const ROLE = "arn:aws:iam::123456789012:role/agentx-staging-cloudformation";

export async function seeded(region = STAGING_SETTINGS.region): Promise<MemoryParameterStore> {
  const store = new MemoryParameterStore();
  await writeEnvironmentSettings(store, {
    ...STAGING_SETTINGS,
    region,
    access: { artifactBucket: "b", cloudFormationRoleArn: ROLE, operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" },
  });
  return store;
}

export function stacks(parameters: Record<string, Record<string, string>>): ConfigServices["stacks"] {
  return {
    async describe(name): Promise<StackDescription | undefined> {
      const values = parameters[name];
      return values === undefined ? undefined : { status: "UPDATE_COMPLETE", outputs: { OperatorAlertsTopicArn: "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts" }, parameters: values };
    },
  };
}

export function services(overrides: Partial<ConfigServices> & { store: MemoryParameterStore }): ConfigServices & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    secrets: memoryInitSecrets(),
    cloudFormation: fakeCloudFormation({ parameters: { SlackThreadTurnsPerMinute: "6", BudgetMonthlyUsd: "100", ModelId: "amazon.nova-pro-v1:0" } }),
    stacks: stacks({ "agentx-staging-control-plane": { SlackThreadTurnsPerMinute: "6", BudgetMonthlyUsd: "100", BudgetScope: "tag", SlackAppPostedMessages: "accept", SlackMemberWorkspaceLimit: "3", SlackOrganizationWorkspaceLimit: "20" }, "agentx-staging-slack": { ModelId: "us.anthropic.claude-sonnet-4-6", GateClassifierModelId: "amazon.nova-lite-v1:0", SlowTurnMinutes: "5" }, "agentx-staging-runtime": { ModelId: "amazon.nova-pro-v1:0" } }),
    identity: { get: async () => ({ account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/agentx-staging-operator/alice" }) },
    checks: () => passingChecks(),
    alerts: fakeAlerts({ confirmAfterPolls: 0 }),
    prompter: scriptedPrompter([]),
    processEnv: {},
    write: (line) => lines.push(line),
    now: () => T0,
    sleep: async () => undefined,
    pollMs: 0,
    ...overrides,
  };
}

/** services() over a freshly seeded store, as seeded() writes it. */
export async function configServicesFor(overrides: Partial<ConfigServices> = {}): Promise<ConfigServices & { lines: string[] }> {
  return services({ store: await seeded(), ...overrides } as Partial<ConfigServices> & { store: MemoryParameterStore });
}
