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

/**
 * Issue #205: config set records each change through the admin API. By default the services answer
 * those two routes here, so a test about the change itself needs no broker; `records` holds what
 * was sent (tests/contract/config-set-audit.test.ts runs them against the real broker).
 */
export function fakeChangeRecorder(): typeof fetch & { records: Array<{ path: string; body: Record<string, unknown> }> } {
  const records: Array<{ path: string; body: Record<string, unknown> }> = [];
  let count = 0;
  const recorder = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    records.push({ path, body });
    const proposedAt = new Date(T0).toISOString();
    const outcome = path.endsWith("/outcome") ? body.outcome : undefined;
    count += path === "/v1/admin/changes/config" ? 1 : 0;
    const change = {
      changeId: `00000000-0000-4000-8000-${String(count).padStart(12, "0")}`, kind: "set_config", traceId: "trace", admin: { issuer: "https://identity.example.test", subject: "admin-subject" },
      client: { cliVersion: "0.0.0" }, change: {}, effect: "", methodsOffered: ["cli"], methodUsed: "cli", proposedAt,
      status: outcome === undefined ? "applying" : outcome,
    };
    return Response.json({ change }, { status: path === "/v1/admin/changes/config" ? 201 : 200 });
  };
  return Object.assign(recorder, { records });
}

export const ADMIN_SESSION = { controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", accessToken: "admin-token-for-tests" };

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
    adminSession: async () => ADMIN_SESSION,
    fetch: fakeChangeRecorder(),
    ...overrides,
  };
}

/** services() over a freshly seeded store, as seeded() writes it. */
export async function configServicesFor(overrides: Partial<ConfigServices> = {}): Promise<ConfigServices & { lines: string[] }> {
  return services({ store: await seeded(), ...overrides } as Partial<ConfigServices> & { store: MemoryParameterStore });
}
