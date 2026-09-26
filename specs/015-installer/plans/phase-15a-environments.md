# Phase 15a: Named Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two AgentX environments can live in one AWS account without any name colliding, each
environment's settings live in SSM under `/agentx/<env>/` with a lock, any machine can set itself
up from SSM with `agentx env use`, and the existing production deployment is registered as an
environment with `agentx env adopt` without changing a single resource.

**Architecture:** A new naming module (`infra/lib/naming.ts`) produces every account-wide name
from an environment name, or reproduces today's fixed names exactly when no environment is given
("legacy naming"). Every stack takes an optional `naming` prop that defaults to legacy naming, and
`infra/bin/agentx.ts` picks environment naming when the `agentxEnv` CDK context is set. Snapshots
of the legacy templates, recorded before any change, prove the live deployment's templates do not
change. Connector secrets and metrics get per-environment prefixes that the runtime code reads
from environment variables set only under environment naming. On the CLI side, a new
`packages/cli/src/environments/` folder holds the SSM settings store, the lock, the local cache,
and the `env list|use|adopt` commands.

**Tech Stack:** TypeScript 5.9 strict (`exactOptionalPropertyTypes`), Node 22.19 to 22.x, Zod 4,
Vitest, AWS CDK v2 (`aws-cdk-lib` 2.269.0, `aws-cdk-lib/assertions`), AWS SDK v3 3.1134.0
(`@aws-sdk/client-ssm`, `@aws-sdk/client-cloudformation`, `@aws-sdk/client-sts`), commander 15.

**Spec:** [../spec.md](../spec.md): FR-001 to FR-006, the secret and settings naming in FR-002 and
FR-003, and the `agentx:env` tag in FR-047. The phase map is in [README.md](README.md).

**Branch:** `feat/015a-environments`, cut from mainline after the spec PR merges. One PR.

## Global Constraints

- **The live deployment does not change.** With no `agentxEnv` context, `npm run infra:synth`
  produces the same templates as before this phase, byte for byte after asset hashes are
  normalized. Task 2 records the snapshots before any other change; no later task may update them.
- **No regressions.** Every existing test passes with its assertions unchanged. A test helper may
  gain an optional parameter; existing calls behave exactly as before.
- **Environment names:** lowercase letters, digits and hyphens, starting with a letter, not ending
  with a hyphen, at most 20 characters: `^[a-z](?:[a-z0-9-]{0,18}[a-z0-9])?$`. The default is
  `production`.
- **Environment naming, exact values:**
  - stacks: `agentx-<env>-foundation`, `agentx-<env>-runtime`, `agentx-<env>-control-plane`,
    `agentx-<env>-slack`;
  - worker security group: `agentx-<env>-workers`; control-plane HTTP API: `agentx-<env>-control-plane`;
  - foundation `Name` tag prefix: `agentx-<env>` (for example `agentx-staging-public-a`);
  - AgentCore runtime: `agentx_<env with - replaced by _>_worker`;
  - alerts topic: `agentx-<env>-alerts`; alarms: `agentx-<env>-<Suffix>` (for example
    `agentx-staging-ConnectorBroken`);
  - connector secrets: `agentx/<env>/connectors/<name>`;
  - metrics namespace: `AgentX/<env>`;
  - SSM settings prefix: `/agentx/<env>/`;
  - tag on every taggable resource: `agentx:env=<env>`.
- **Legacy naming, exact values (today's names):** stacks `AgentXProductionFoundation`,
  `AgentXProductionRuntime`, `AgentXControlPlane`, `AgentXSlackOrchestrator`; security group
  `agentx-production-workers`; HTTP API `agentx-control-plane`; `Name` tag prefix
  `agentx-production`; runtime `agentx_production_worker`; topic `AgentXOperatorAlerts`;
  alarms `AgentX<Suffix>`; connector secrets `agentx/connectors/<name>`; metrics namespace
  `AgentX`; no `agentx:env` tag and no new environment variables on any function.
- **SSM parameters for an environment** (all `String`, Standard tier):
  - `/agentx/<env>/settings`: the environment settings JSON (Task 6 schema);
  - `/agentx/<env>/lock`: present only while a command holds the lock.
- **No secret values in SSM or the local cache.** Settings hold names, ARNs, URLs and IDs only.
- **Adopt is read-only for AWS resources.** `env adopt` may call only `sts:GetCallerIdentity`,
  `cloudformation:DescribeStacks` and SSM parameter calls under `/agentx/<env>/`.
- **Commands:** gate is `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
  Use Node 22 (`export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH` on the
  owner's machine). Known load flakes (issue #59): rerun a timed-out CDK packaging test file alone.

## Review Focus

1. **An environment name that is valid for SSM but not for AgentCore or a stack** (for example
   `a--b` or `prod-` or `Prod`). It must be refused before anything is named with it. Task 1 tests
   these names.
2. **A second environment in the same account colliding with the first on a name nobody listed.**
   Task 3 synthesizes `production` and `staging` side by side and asserts no two physical names,
   alarm names, topic names, runtime names or export names are equal.
3. **A lock left behind by a crashed command.** It must name who holds it and since when, refuse
   by default, and allow takeover only after 2 hours and only with explicit confirmation. Task 7
   tests fresh, stale and missing locks.
4. **A stale or hand-edited local cache** pointing at another environment's control plane. The
   cache must be rebuilt from SSM by `env use`, and a cache whose `env` field disagrees with
   `--env` must be refused. Task 8 tests it.
5. **Adopting when a stack is missing or its outputs are incomplete.** Adopt must refuse and write
   nothing to SSM, not store a partial record. Task 9 tests a missing Slack stack and a missing
   output.

---

### Task 1: Environment name contract

**Files:**
- Create: `packages/contracts/src/environments.ts`
- Modify: `packages/contracts/src/index.ts` (add `export * from "./environments.js";`)
- Test: `tests/contract/environments.test.ts`

**Interfaces:**
- Produces:
  - `ENVIRONMENT_NAME_PATTERN: RegExp`
  - `EnvironmentNameSchema: z.ZodString`
  - `DEFAULT_ENVIRONMENT = "production"`
  - `type StackPart = "foundation" | "runtime" | "control-plane" | "slack"`
  - `STACK_PARTS: readonly StackPart[]` (deploy order: foundation, runtime, control-plane, slack)
  - `environmentStackName(env: string, part: StackPart): string`
  - `environmentSettingsPrefix(env: string): string` → `/agentx/<env>/`
  - `environmentConnectorSecretPrefix(env: string): string` → `agentx/<env>/connectors/`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENVIRONMENT,
  EnvironmentNameSchema,
  STACK_PARTS,
  environmentConnectorSecretPrefix,
  environmentSettingsPrefix,
  environmentStackName,
} from "@agentx/contracts";

describe("environment names", () => {
  it.each(["production", "staging", "dev-2", "a", "a1", "abcdefghijklmnopqrst"])("accepts %s", (name) => {
    expect(EnvironmentNameSchema.safeParse(name).success).toBe(true);
  });

  it.each(["", "Prod", "prod-", "-prod", "1prod", "pro_d", "pro.d", "a--b", "abcdefghijklmnopqrstu", "prod/x"])(
    "refuses %j",
    (name) => {
      expect(EnvironmentNameSchema.safeParse(name).success).toBe(false);
    },
  );

  it("defaults to production", () => {
    expect(DEFAULT_ENVIRONMENT).toBe("production");
  });

  it("names stacks, settings and connector secrets with the environment", () => {
    expect(STACK_PARTS).toEqual(["foundation", "runtime", "control-plane", "slack"]);
    expect(environmentStackName("staging", "control-plane")).toBe("agentx-staging-control-plane");
    expect(environmentSettingsPrefix("staging")).toBe("/agentx/staging/");
    expect(environmentConnectorSecretPrefix("staging")).toBe("agentx/staging/connectors/");
  });

  it("refuses to build a name from an invalid environment", () => {
    expect(() => environmentStackName("Bad", "slack")).toThrow(/environment name/);
    expect(() => environmentSettingsPrefix("a--b")).toThrow(/environment name/);
  });
});
```

`a--b` is refused because a doubled hyphen would make `agentx-a--b-slack` ambiguous to read and
because AgentCore names derived from it (`agentx_a__b_worker`) are hard to tell apart.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/environments.test.ts`
Expected: FAIL, `EnvironmentNameSchema` is not exported from `@agentx/contracts`.

- [ ] **Step 3: Write the implementation**

```ts
import { z } from "zod";

/** Lowercase letters, digits and single hyphens; starts with a letter; at most 20 characters. */
export const ENVIRONMENT_NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,18}[a-z0-9])?$/;

export const EnvironmentNameSchema = z
  .string()
  .regex(ENVIRONMENT_NAME_PATTERN, "environment name must be lowercase letters, digits and hyphens, start with a letter, and be at most 20 characters")
  .refine((name) => !name.includes("--"), "environment name must not contain a doubled hyphen");

export const DEFAULT_ENVIRONMENT = "production";

export type StackPart = "foundation" | "runtime" | "control-plane" | "slack";

/** In deploy order. */
export const STACK_PARTS: readonly StackPart[] = ["foundation", "runtime", "control-plane", "slack"];

function checked(env: string): string {
  const parsed = EnvironmentNameSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid environment name ${JSON.stringify(env)}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

export function environmentStackName(env: string, part: StackPart): string {
  return `agentx-${checked(env)}-${part}`;
}

export function environmentSettingsPrefix(env: string): string {
  return `/agentx/${checked(env)}/`;
}

export function environmentConnectorSecretPrefix(env: string): string {
  return `agentx/${checked(env)}/connectors/`;
}
```

The error message must contain "environment name" (the test matches `/environment name/`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/contract/environments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/environments.ts packages/contracts/src/index.ts tests/contract/environments.test.ts
git commit -m "feat(contracts): environment names"
```

### Task 2: Snapshot today's templates (characterization, before any infra change)

**Files:**
- Create: `tests/contract/legacy-templates.test.ts`
- Create: `tests/support/template-snapshot.ts`
- Create (generated): `tests/contract/__snapshots__/legacy-templates.test.ts.snap`

**Interfaces:**
- Produces: `normalizedTemplate(stack: Stack): unknown` in `tests/support/template-snapshot.ts`,
  and `buildProductionApp(context?: Record<string, string>): App` which builds the app exactly as
  `infra/bin/agentx.ts` does. Task 3 changes `infra/bin/agentx.ts` to export the builder and this
  helper then calls it; until then the helper constructs the four production stacks and the control
  plane with the same ids and props as the bin file.

This task records what the live deployment's templates look like now. It must be committed before
Task 3 touches any stack.

- [ ] **Step 1: Write the helper and the snapshot test**

`tests/support/template-snapshot.ts`:

```ts
import { App, type Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AgentRuntimeStack } from "../../infra/lib/agent-runtime.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { ProductionFoundationStack } from "../../infra/lib/production-foundation.js";
import { SlackOrchestratorStack } from "../../infra/lib/slack-orchestrator.js";

/** Asset hashes change whenever bundled code changes; the names and shapes must not. */
export function normalizedTemplate(stack: Stack): unknown {
  const text = JSON.stringify(Template.fromStack(stack).toJSON());
  return JSON.parse(text.replace(/[a-f0-9]{64}/g, "<asset-hash>"));
}

/** The production stacks, built with the same ids and props as infra/bin/agentx.ts. */
export function legacyProductionStacks(): Stack[] {
  const app = new App({ context: { "@aws-cdk/core:defaultCrossStackReferences": "strong" } });
  const region = "us-east-1";
  return [
    new ControlPlaneStack(app, "AgentXControlPlane", {
      description: "AgentX authenticated control plane and durable dispatch foundation",
    }),
    new ProductionFoundationStack(app, "AgentXProductionFoundation", {
      description: "Stable AgentX production network, encryption, and persistent workspace capacity",
      deploymentRegion: region,
      env: { region },
      terminationProtection: true,
    }),
    new AgentRuntimeStack(app, "AgentXProductionRuntime", {
      description: "AgentX production coding runtime on stable EBS-backed capacity",
      deploymentRegion: region,
      env: { region },
      terminationProtection: true,
    }),
    new SlackOrchestratorStack(app, "AgentXSlackOrchestrator", {
      description: "Hosted AgentX Slack orchestrator on ECS Fargate",
      env: { region },
    }),
  ];
}
```

`tests/contract/legacy-templates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { legacyProductionStacks, normalizedTemplate } from "../support/template-snapshot.js";

// Spec 015 phase 15a: environments must not change the live deployment. These snapshots were
// recorded before any naming change and must not be updated by phase 15a.
describe("legacy production templates", () => {
  for (const stack of legacyProductionStacks()) {
    it(`${stack.stackName} is unchanged`, () => {
      expect(normalizedTemplate(stack)).toMatchSnapshot();
    }, 120_000);
  }
});
```

- [ ] **Step 2: Record the snapshots**

Run: `npx vitest run tests/contract/legacy-templates.test.ts`
Expected: PASS with "4 snapshots written". Open the `.snap` file and confirm it contains
`"GroupName": "agentx-production-workers"`, `"AgentRuntimeName": "agentx_production_worker"`,
`"TopicName": "AgentXOperatorAlerts"` and `"AlarmName": "AgentXConnectorBroken"`.

- [ ] **Step 3: Prove the snapshot catches a change**

Temporarily change `groupName: "agentx-production-workers"` in
`infra/lib/production-foundation.ts` to `"agentx-production-workers-x"`, run the test, and see it
FAIL on the foundation snapshot. Revert the change and see it PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/support/template-snapshot.ts tests/contract/legacy-templates.test.ts tests/contract/__snapshots__/legacy-templates.test.ts.snap
git commit -m "test(infra): snapshot the legacy production templates"
```

### Task 3: Naming module and environment-named stacks

**Files:**
- Create: `infra/lib/naming.ts`
- Modify: `infra/lib/production-foundation.ts` (security group name, `Environment` tag value)
- Modify: `infra/lib/agent-runtime.ts` (runtime name)
- Modify: `infra/lib/control-plane.ts` (topic, alarm names, runtime ARN pattern, connector secret
  resources; props type)
- Modify: `infra/lib/slack-orchestrator.ts` (props type only in this task)
- Modify: `infra/bin/agentx.ts` (export `buildAgentXApp`, read `agentxEnv`)
- Modify: `tests/support/template-snapshot.ts` (build through `buildAgentXApp`)
- Test: `tests/contract/environment-naming.test.ts`

**Interfaces:**
- Consumes: Task 1's `EnvironmentNameSchema`, `environmentStackName`, `environmentConnectorSecretPrefix`, `StackPart`.
- Produces (in `infra/lib/naming.ts`):

```ts
export interface AgentXNaming {
  /** undefined for legacy naming. */
  readonly env: string | undefined;
  stackName(part: StackPart): string;
  readonly workerSecurityGroupName: string;
  readonly apiName: string;
  /** Prefix of the foundation's `Name` tags. */
  readonly resourcePrefix: string;
  readonly runtimeName: string;
  readonly alertsTopicName: string;
  alarmName(suffix: string): string;
  readonly connectorSecretPrefix: string;
  readonly metricsNamespace: string;
  /** The value of the resource `Environment` tag used by the foundation stack. */
  readonly environmentTagValue: string;
}
export function legacyNaming(): AgentXNaming;
export function environmentNaming(env: string): AgentXNaming;
export function namingFromContext(app: App): AgentXNaming;  // agentxEnv context; absent → legacy
export const LEGACY_STACK_NAMES: Record<StackPart, string>;
```

  - Each stack's props gain `naming?: AgentXNaming` (default `legacyNaming()`).
  - `infra/bin/agentx.ts` exports `buildAgentXApp(context?: Record<string, unknown>): App`.

- [ ] **Step 1: Write the failing test**

```ts
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/bin/agentx.js";
import { environmentNaming, legacyNaming, namingFromContext } from "../../infra/lib/naming.js";

function productionStacks(app: App): Stack[] {
  return app.node.children.filter((child): child is Stack => Stack.isStack(child))
    .filter((stack) => !stack.stackName.includes("ReleasePipeline"));
}

// Names AWS requires to be unique in an account and region. Resource "Name" keys (API names,
// authorizer names) are checked separately: they are not unique-constrained, but must still differ.
const PHYSICAL_NAME_KEYS = ["GroupName", "AgentRuntimeName", "TopicName", "AlarmName", "RoleName", "QueueName", "TableName", "BucketName", "LogGroupName"];

function physicalNames(stack: Stack): string[] {
  const resources = Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, unknown> }>;
  return Object.values(resources).flatMap((resource) => [
    ...PHYSICAL_NAME_KEYS.map((key) => resource.Properties?.[key]),
    resource.Type === "AWS::ApiGatewayV2::Api" ? resource.Properties?.Name : undefined,
  ].filter((value): value is string => typeof value === "string"));
}

describe("legacy naming", () => {
  it("reproduces today's names exactly", () => {
    const naming = legacyNaming();
    expect(naming.env).toBeUndefined();
    expect(naming.stackName("foundation")).toBe("AgentXProductionFoundation");
    expect(naming.stackName("runtime")).toBe("AgentXProductionRuntime");
    expect(naming.stackName("control-plane")).toBe("AgentXControlPlane");
    expect(naming.stackName("slack")).toBe("AgentXSlackOrchestrator");
    expect(naming.workerSecurityGroupName).toBe("agentx-production-workers");
    expect(naming.apiName).toBe("agentx-control-plane");
    expect(naming.resourcePrefix).toBe("agentx-production");
    expect(naming.runtimeName).toBe("agentx_production_worker");
    expect(naming.alertsTopicName).toBe("AgentXOperatorAlerts");
    expect(naming.alarmName("ConnectorBroken")).toBe("AgentXConnectorBroken");
    expect(naming.connectorSecretPrefix).toBe("agentx/connectors/");
    expect(naming.metricsNamespace).toBe("AgentX");
    expect(naming.environmentTagValue).toBe("production");
  });

  it("is used when the agentxEnv context is absent", () => {
    expect(namingFromContext(new App()).env).toBeUndefined();
  });
});

describe("environment naming", () => {
  it("names everything with the environment", () => {
    const naming = environmentNaming("dev-2");
    expect(naming.env).toBe("dev-2");
    expect(naming.stackName("control-plane")).toBe("agentx-dev-2-control-plane");
    expect(naming.workerSecurityGroupName).toBe("agentx-dev-2-workers");
    expect(naming.apiName).toBe("agentx-dev-2-control-plane");
    expect(naming.resourcePrefix).toBe("agentx-dev-2");
    expect(naming.runtimeName).toBe("agentx_dev_2_worker");
    expect(naming.alertsTopicName).toBe("agentx-dev-2-alerts");
    expect(naming.alarmName("ConnectorBroken")).toBe("agentx-dev-2-ConnectorBroken");
    expect(naming.connectorSecretPrefix).toBe("agentx/dev-2/connectors/");
    expect(naming.metricsNamespace).toBe("AgentX/dev-2");
    expect(naming.environmentTagValue).toBe("dev-2");
  });

  it("refuses an invalid environment from context", () => {
    expect(() => namingFromContext(new App({ context: { agentxEnv: "Prod" } }))).toThrow(/environment name/);
  });

  it("deploys two environments in one account with no shared physical name or stack name", () => {
    const production = productionStacks(buildAgentXApp({ agentxEnv: "production" }));
    const staging = productionStacks(buildAgentXApp({ agentxEnv: "staging" }));
    expect(production.map((stack) => stack.stackName).sort()).toEqual([
      "agentx-production-control-plane", "agentx-production-foundation", "agentx-production-runtime", "agentx-production-slack",
    ]);
    const productionNames = new Set(production.flatMap(physicalNames));
    const shared = staging.flatMap(physicalNames).filter((name) => productionNames.has(name));
    expect(shared).toEqual([]);
  }, 240_000);

  it("tags every stack's resources with agentx:env", () => {
    const staging = productionStacks(buildAgentXApp({ agentxEnv: "staging" }));
    const control = staging.find((stack) => stack.stackName === "agentx-staging-control-plane")!;
    Template.fromStack(control).hasResourceProperties("AWS::DynamoDB::Table", {
      Tags: Match.arrayWith([{ Key: "agentx:env", Value: "staging" }]),
    });
  }, 120_000);

  it("scopes runtime ARNs and connector secrets to the environment", () => {
    const staging = productionStacks(buildAgentXApp({ agentxEnv: "staging" }));
    const control = staging.find((stack) => stack.stackName === "agentx-staging-control-plane")!;
    const text = JSON.stringify(Template.fromStack(control).toJSON());
    expect(text).toContain("runtime/agentx_staging_worker-*");
    expect(text).not.toContain(":runtime/*");
    expect(text).toContain("secret:agentx/staging/connectors/*");
    expect(text).not.toContain("secret:agentx/connectors/*");
  }, 120_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/environment-naming.test.ts`
Expected: FAIL, cannot resolve `../../infra/lib/naming.js`.

- [ ] **Step 3: Write the naming module**

```ts
import type { App } from "aws-cdk-lib";
import {
  EnvironmentNameSchema,
  environmentConnectorSecretPrefix,
  environmentStackName,
  type StackPart,
} from "@agentx/contracts";

export interface AgentXNaming {
  readonly env: string | undefined;
  stackName(part: StackPart): string;
  readonly workerSecurityGroupName: string;
  readonly apiName: string;
  readonly resourcePrefix: string;
  readonly runtimeName: string;
  readonly alertsTopicName: string;
  alarmName(suffix: string): string;
  readonly connectorSecretPrefix: string;
  readonly metricsNamespace: string;
  readonly environmentTagValue: string;
}

export const LEGACY_STACK_NAMES: Record<StackPart, string> = {
  foundation: "AgentXProductionFoundation",
  runtime: "AgentXProductionRuntime",
  "control-plane": "AgentXControlPlane",
  slack: "AgentXSlackOrchestrator",
};

/** Today's fixed names. The deployment that predates environments keeps them forever. */
export function legacyNaming(): AgentXNaming {
  return {
    env: undefined,
    stackName: (part) => LEGACY_STACK_NAMES[part],
    workerSecurityGroupName: "agentx-production-workers",
    apiName: "agentx-control-plane",
    resourcePrefix: "agentx-production",
    runtimeName: "agentx_production_worker",
    alertsTopicName: "AgentXOperatorAlerts",
    alarmName: (suffix) => `AgentX${suffix}`,
    connectorSecretPrefix: "agentx/connectors/",
    metricsNamespace: "AgentX",
    environmentTagValue: "production",
  };
}

export function environmentNaming(env: string): AgentXNaming {
  const name = EnvironmentNameSchema.parse(env);
  return {
    env: name,
    stackName: (part) => environmentStackName(name, part),
    workerSecurityGroupName: `agentx-${name}-workers`,
    apiName: `agentx-${name}-control-plane`,
    resourcePrefix: `agentx-${name}`,
    // AgentCore runtime names allow letters, digits and underscores only.
    runtimeName: `agentx_${name.replaceAll("-", "_")}_worker`,
    alertsTopicName: `agentx-${name}-alerts`,
    alarmName: (suffix) => `agentx-${name}-${suffix}`,
    connectorSecretPrefix: environmentConnectorSecretPrefix(name),
    metricsNamespace: `AgentX/${name}`,
    environmentTagValue: name,
  };
}

export function namingFromContext(app: App): AgentXNaming {
  const env = app.node.tryGetContext("agentxEnv") as unknown;
  if (env === undefined) return legacyNaming();
  if (typeof env !== "string") throw new Error("invalid environment name: agentxEnv context must be a string");
  const parsed = EnvironmentNameSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid environment name ${JSON.stringify(env)}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return environmentNaming(parsed.data);
}
```

- [ ] **Step 4: Thread `naming` through the stacks**

In each stack, add `naming?: AgentXNaming` to the props and read `const naming = props?.naming ?? legacyNaming();`
at the top of the constructor. `ControlPlaneStack` and `SlackOrchestratorStack` change their props
type from `StackProps` to:

```ts
export interface ControlPlaneStackProps extends StackProps { naming?: AgentXNaming }
export interface SlackOrchestratorStackProps extends StackProps { naming?: AgentXNaming }
```

Replace, exactly:
- `production-foundation.ts`: `groupName: "agentx-production-workers"` → `groupName: naming.workerSecurityGroupName`.
  In `resourceTags`, the `Environment` value `"production"` → `naming.environmentTagValue` (pass
  `naming` into `resourceTags` as a second parameter), and every `Name` tag literal that starts
  with `agentx-production` uses `naming.resourcePrefix` instead (for example
  `` `${naming.resourcePrefix}-public-${suffix}` ``).
- `agent-runtime.ts`: `agentRuntimeName: "agentx_production_worker"` → `agentRuntimeName: naming.runtimeName`.
- `control-plane.ts`:
  - `topicName: "AgentXOperatorAlerts"` → `topicName: naming.alertsTopicName`;
  - the HTTP API's `name: "agentx-control-plane"` → `name: naming.apiName` (the authorizer's
    `name: "agentx-jwt"` stays: it is scoped to its API);
  - each `alarmName: "AgentX<Suffix>"` → `alarmName: naming.alarmName("<Suffix>")` (ConnectorBroken,
    ConnectorNotConnected, EmptyResponses, RecordingFailures, SlackDeadLetters);
  - both `resourceName: "agentx/connectors/*"` → `resourceName: \`${naming.connectorSecretPrefix}*\``;
  - `runtimeArn(stack)` gains a `naming` parameter and returns `runtime/*` for legacy naming and
    `runtime/${naming.runtimeName}-*` for environment naming (AgentCore appends `-<id>` to the
    runtime name in its ARN).

Then in `infra/bin/agentx.ts`, wrap the existing body in an exported builder and keep the direct
run:

```ts
export function buildAgentXApp(context: Record<string, unknown> = {}): App {
  const app = new App({ context: { "@aws-cdk/core:defaultCrossStackReferences": "strong", ...context } });
  const naming = namingFromContext(app);
  // ... existing body, with each production stack given
  //   stackName: naming.stackName("<part>") only when naming.env is defined, and naming
  // ... and, only when naming.env is defined:
  //   Tags.of(app).add("agentx:env", naming.env);
  // The release pipeline and the demo runtime are legacy-only: when naming.env is defined, do not
  // create AgentXReleasePipeline and refuse agentxDeploymentMode=demo-microvm with a clear error.
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) buildAgentXApp().synth();
```

Keep construct ids unchanged (`"AgentXControlPlane"` and so on). Set `stackName` only for
environment naming, so legacy stacks keep their names and templates.

Update `tests/support/template-snapshot.ts` so `legacyProductionStacks()` returns the production
stacks of `buildAgentXApp()` (no context), filtered to the four stacks in the snapshot.

- [ ] **Step 5: Run the new test, the legacy snapshots and the infra tests**

Run: `npx vitest run tests/contract/environment-naming.test.ts tests/contract/legacy-templates.test.ts tests/contract/infrastructure.test.ts`
Expected: PASS. The legacy snapshots are unchanged (no "snapshot updated" or "obsolete" lines).

- [ ] **Step 6: Synthesize both ways**

Run: `npm run infra:synth` (legacy) and `npm run build --workspace @agentx/infra && npx cdk synth --app 'node infra/dist/bin/agentx.js' -c agentxEnv=staging -q`
Expected: both succeed; the second lists `agentx-staging-foundation`, `agentx-staging-runtime`,
`agentx-staging-control-plane`, `agentx-staging-slack` and no `AgentXReleasePipeline`.

- [ ] **Step 7: Commit**

```bash
git add infra/lib/naming.ts infra/lib/*.ts infra/bin/agentx.ts tests/support/template-snapshot.ts tests/contract/environment-naming.test.ts
git commit -m "feat(infra): name every account-wide resource with the environment"
```

### Task 4: Per-environment connector secrets

**Files:**
- Modify: `packages/contracts/src/credentials.ts`
- Modify: `packages/broker/src/aws/credentials.ts` (registry option `connectorSecretPrefix`)
- Modify: `packages/broker/src/aws/broker.ts` (pass `process.env.CONNECTOR_SECRET_PREFIX`)
- Modify: `infra/lib/control-plane.ts` (set `CONNECTOR_SECRET_PREFIX` on the broker only for environment naming)
- Modify: `packages/cli/src/main.ts` (help text only)
- Test: `tests/contract/credential-contracts.test.ts` (append), `tests/contract/credential-registry.test.ts` (append), `tests/contract/environment-naming.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's `ENVIRONMENT_NAME_PATTERN`; Task 3's `naming.connectorSecretPrefix`.
- Produces: `CredentialRegistrationSchema.secretName` accepts `agentx/connectors/<name>` and
  `agentx/<env>/connectors/<name>`; `ConnectorCredentialsConfiguration.connectorSecretPrefix?: string`
  (default `CONNECTOR_SECRET_PREFIX`), enforced by `CredentialRegistry.register`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/contract/credential-contracts.test.ts`:

```ts
describe("connector secret names per environment", () => {
  const registration = (secretName: string) => CredentialRegistrationSchema.safeParse({ ref: "linear", type: "static-secret", secretName });

  it("accepts the legacy and the environment forms", () => {
    expect(registration("agentx/connectors/linear").success).toBe(true);
    expect(registration("agentx/staging/connectors/linear").success).toBe(true);
  });

  it.each(["agentx/Staging/connectors/linear", "agentx/staging/linear", "agentx/staging/connectors/", "agentx/a--b/connectors/x", "agentx/staging/connectors/a/b"])(
    "refuses %s",
    (secretName) => {
      expect(registration(secretName).success).toBe(false);
    },
  );
});
```

Append to `tests/contract/credential-registry.test.ts`, using that file's existing registry
factory and administrator identity helpers (read the top of the file for their names; pass the new
option through the factory's options object):

```ts
it("refuses a secret outside the deployment's own connector prefix", async () => {
  const registry = createRegistry({ connectorSecretPrefix: "agentx/staging/connectors/" });
  await expect(registry.register(administrator, { ref: "linear", type: "static-secret", secretName: "agentx/production/connectors/linear" }))
    .rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("agentx/staging/connectors/") });
  await expect(registry.register(administrator, { ref: "linear", type: "static-secret", secretName: "agentx/connectors/linear" }))
    .rejects.toMatchObject({ code: "CONFIG_INVALID" });
});
```

If the file's factory does not accept options, add an optional parameter to it (Global
Constraints: existing calls unchanged).

Append to `tests/contract/environment-naming.test.ts`:

```ts
it("tells the environment's broker its connector secret prefix, and leaves legacy unchanged", () => {
  const stagingControl = productionStacks(buildAgentXApp({ agentxEnv: "staging" })).find((stack) => stack.stackName === "agentx-staging-control-plane")!;
  expect(JSON.stringify(Template.fromStack(stagingControl).toJSON())).toContain("\"CONNECTOR_SECRET_PREFIX\":\"agentx/staging/connectors/\"");
  const legacyControl = productionStacks(buildAgentXApp()).find((stack) => stack.stackName === "AgentXControlPlane")!;
  expect(JSON.stringify(Template.fromStack(legacyControl).toJSON())).not.toContain("CONNECTOR_SECRET_PREFIX");
}, 240_000);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/credential-contracts.test.ts tests/contract/credential-registry.test.ts tests/contract/environment-naming.test.ts`
Expected: FAIL: the environment form is refused by the schema, the registry accepts any valid
prefix, and `CONNECTOR_SECRET_PREFIX` is missing.

- [ ] **Step 3: Implement**

In `packages/contracts/src/credentials.ts`, replace `SecretNameSchema` with:

```ts
const SECRET_LEAF = "(?!\\.+$)[A-Za-z0-9_+=.@-]{1,128}";
// agentx/connectors/<name> (deployments that predate environments) or agentx/<env>/connectors/<name>.
const ENVIRONMENT_SEGMENT = ENVIRONMENT_NAME_PATTERN.source.slice(1, -1);
const SecretNameSchema = z.string()
  .regex(
    new RegExp(`^(?:${escapeRegExp(CONNECTOR_SECRET_PREFIX)}|agentx/${ENVIRONMENT_SEGMENT}/connectors/)${SECRET_LEAF}$`),
    "secret name must be agentx/connectors/<name> or agentx/<environment>/connectors/<name>",
  )
  .refine((name) => !name.split("/")[1]?.includes("--"), "secret name must be agentx/connectors/<name> or agentx/<environment>/connectors/<name>");
```

(import `ENVIRONMENT_NAME_PATTERN` from `./environments.js`).

In `CredentialRegistry.register`, after the schema parse and before the GitHub App check:

```ts
const prefix = this.options.connectorSecretPrefix ?? CONNECTOR_SECRET_PREFIX;
if (!registration.secretName.startsWith(prefix)) {
  throw agentXError("CONFIG_INVALID", `secret name must be ${prefix}<name> in this deployment`);
}
```

Add `connectorSecretPrefix?: string` to `ConnectorCredentialsConfiguration` with a one-line
comment. In `broker.ts`, where the connector credentials configuration is built, add
`...(process.env.CONNECTOR_SECRET_PREFIX ? { connectorSecretPrefix: process.env.CONNECTOR_SECRET_PREFIX } : {})`.
Change the `AccessDeniedException` message in `secretsManagerSecretStore` to say
"connector secrets must be named with this deployment's connector prefix" instead of naming the
legacy prefix. In `control-plane.ts`, after the broker is created:
`if (naming.env !== undefined) broker.addEnvironment("CONNECTOR_SECRET_PREFIX", naming.connectorSecretPrefix);`.
In `packages/cli/src/main.ts`, change the three help strings that say `agentx/connectors/<name>` to
`agentx/connectors/<name> or agentx/<env>/connectors/<name>`.

- [ ] **Step 4: Run the tests, then the legacy snapshots**

Run: `npx vitest run tests/contract/credential-contracts.test.ts tests/contract/credential-registry.test.ts tests/contract/credential-cli.test.ts tests/contract/credential-authorize.test.ts tests/contract/environment-naming.test.ts tests/contract/legacy-templates.test.ts`
Expected: PASS, legacy snapshots unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/credentials.ts packages/broker/src/aws/credentials.ts packages/broker/src/aws/broker.ts infra/lib/control-plane.ts packages/cli/src/main.ts tests/contract/credential-contracts.test.ts tests/contract/credential-registry.test.ts tests/contract/environment-naming.test.ts
git commit -m "feat: per-environment connector secret prefix"
```

### Task 5: Per-environment metrics namespace

**Files:**
- Modify: `packages/broker/src/aws/connector-metrics.ts`
- Modify: `infra/lib/control-plane.ts` (`agentxSum` namespace; broker `AGENTX_METRICS_NAMESPACE` for environment naming)
- Modify: `infra/lib/slack-orchestrator.ts` (every `metricNamespace: "AgentX"`)
- Test: `tests/contract/connector-metrics.test.ts` (append), `tests/contract/environment-naming.test.ts` (append)

**Interfaces:**
- Consumes: Task 3's `naming.metricsNamespace`.
- Produces: `emitConnectorMetric(metric, connector, count = 1, write = stdout, namespace = metricsNamespace())`
  where `metricsNamespace()` returns `process.env.AGENTX_METRICS_NAMESPACE ?? "AgentX"`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/contract/connector-metrics.test.ts`:

```ts
it("publishes into the configured namespace", () => {
  const lines: string[] = [];
  emitConnectorMetric("ConnectorNotConnected", "linear", 1, (line) => lines.push(line), "AgentX/staging");
  expect(JSON.parse(lines[0]!)._aws.CloudWatchMetrics[0].Namespace).toBe("AgentX/staging");
});

it("defaults to the AgentX namespace", () => {
  const lines: string[] = [];
  emitConnectorMetric("ConnectorNotConnected", "linear", 1, (line) => lines.push(line));
  expect(JSON.parse(lines[0]!)._aws.CloudWatchMetrics[0].Namespace).toBe("AgentX");
});
```

Append to `tests/contract/environment-naming.test.ts`:

```ts
it("keeps each environment's metrics and alarms in its own namespace", () => {
  const stacks = productionStacks(buildAgentXApp({ agentxEnv: "staging" }));
  const text = stacks.map((stack) => JSON.stringify(Template.fromStack(stack).toJSON())).join("\n");
  expect(text).not.toMatch(/"(?:Namespace|MetricNamespace)":"AgentX"/);
  expect(text).toContain("\"AGENTX_METRICS_NAMESPACE\":\"AgentX/staging\"");
  expect(text).toMatch(/"(?:Namespace|MetricNamespace)":"AgentX\/staging"/);
}, 240_000);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/connector-metrics.test.ts tests/contract/environment-naming.test.ts`
Expected: FAIL: the namespace argument is ignored and the staging templates use `AgentX`.

- [ ] **Step 3: Implement**

In `connector-metrics.ts`:

```ts
function metricsNamespace(): string {
  return process.env.AGENTX_METRICS_NAMESPACE ?? "AgentX";
}

export function emitConnectorMetric(metric: ConnectorMetric, connector: string, count = 1, write: Write = stdout, namespace = metricsNamespace()): void {
```

and use `Namespace: namespace` in the line. In `control-plane.ts`, `agentxSum` uses
`namespace: naming.metricsNamespace`, and `if (naming.env !== undefined) broker.addEnvironment("AGENTX_METRICS_NAMESPACE", naming.metricsNamespace);`.
In `slack-orchestrator.ts`, every `metricNamespace: "AgentX"` becomes `metricNamespace: naming.metricsNamespace`.
Run `grep -rn '"AgentX"' infra/lib packages/*/src` afterwards: the only remaining hits are
`naming.ts`'s legacy value and `connector-metrics.ts`'s default.

- [ ] **Step 4: Run the tests and the legacy snapshots**

Run: `npx vitest run tests/contract/connector-metrics.test.ts tests/contract/environment-naming.test.ts tests/contract/legacy-templates.test.ts tests/contract/infrastructure.test.ts`
Expected: PASS, legacy snapshots unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/aws/connector-metrics.ts infra/lib/control-plane.ts infra/lib/slack-orchestrator.ts tests/contract/connector-metrics.test.ts tests/contract/environment-naming.test.ts
git commit -m "feat: per-environment metrics namespace"
```

### Task 6: Environment settings in SSM

**Files:**
- Create: `packages/cli/src/environments/settings.ts`
- Create: `packages/cli/src/environments/parameter-store.ts`
- Modify: `packages/cli/package.json` (add `"@aws-sdk/client-ssm": "3.1134.0"`), then `npm install`
- Test: `tests/contract/environment-settings.test.ts`
- Create: `tests/support/memory-parameter-store.ts`
- Create: `tests/support/environment-fixtures.ts` (exports `stagingSettings`; a test file must
  never import another test file, or Vitest registers its tests twice)

**Interfaces:**
- Consumes: Task 1's `EnvironmentNameSchema`, `environmentSettingsPrefix`, `StackPart`, `STACK_PARTS`.
- Produces:

```ts
// parameter-store.ts
export interface ParameterStore {
  get(name: string): Promise<{ value: string; version: number } | undefined>;
  /** Overwrites unless createOnly; createOnly throws ParameterExistsError when present. */
  put(name: string, value: string, options?: { createOnly?: boolean }): Promise<void>;
  delete(name: string): Promise<void>;  // absent is not an error
  /** Parameter names (not values) under a path, recursively. */
  list(path: string): Promise<string[]>;
}
export class ParameterExistsError extends Error {}
export function ssmParameterStore(client: SSMClient): ParameterStore;

// settings.ts
export const EnvironmentSettingsSchema: z.ZodObject<...>;
export type EnvironmentSettings = z.infer<typeof EnvironmentSettingsSchema>;
export function settingsParameterName(env: string): string;   // /agentx/<env>/settings
export async function readEnvironmentSettings(store: ParameterStore, env: string): Promise<EnvironmentSettings | undefined>;
export async function writeEnvironmentSettings(store: ParameterStore, settings: EnvironmentSettings): Promise<void>;
export async function listEnvironments(store: ParameterStore): Promise<string[]>;
```

`tests/support/memory-parameter-store.ts` exports `MemoryParameterStore implements ParameterStore`
with a public `calls: Array<{ op: string; name: string }>` log and a `values: Map<string, string>`.

The settings schema (exact, `.strict()` at every level):

```ts
export const EnvironmentSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  env: EnvironmentNameSchema,
  account: z.string().regex(/^\d{12}$/),
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/),
  engine: z.enum(["templates", "cdk"]),
  /** A release version such as 1.4.0, or "unversioned" for an adopted deployment. */
  version: z.string().regex(/^(?:\d+\.\d+\.\d+|unversioned)$/),
  /** Legacy for a deployment adopted with fixed stack names. */
  naming: z.enum(["environment", "legacy"]),
  stacks: z.object({ foundation: z.string(), runtime: z.string(), "control-plane": z.string(), slack: z.string() }).strict(),
  controlPlaneUrl: z.string().url(),
  identity: z.object({
    mode: z.enum(["cognito", "oidc"]),
    issuer: z.string().url(),
    audience: z.string().min(1).max(256),
    clientId: z.string().min(1).max(256),
  }).strict(),
  models: z.object({ orchestrator: z.string().min(1), classifier: z.string().min(1), worker: z.string().min(1) }).strict(),
  alertAddress: z.string().min(1).optional(),
  updatedAt: z.iso.datetime(),
}).strict();
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { EnvironmentSettingsSchema, listEnvironments, readEnvironmentSettings, settingsParameterName, writeEnvironmentSettings, type EnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { stagingSettings } from "../support/environment-fixtures.js";

// tests/support/environment-fixtures.ts holds exactly this value:
const expectedFixture: EnvironmentSettings = {
  schemaVersion: 1,
  env: "staging",
  account: "123456789012",
  region: "us-east-1",
  engine: "templates",
  version: "1.0.0",
  naming: "environment",
  stacks: { foundation: "agentx-staging-foundation", runtime: "agentx-staging-runtime", "control-plane": "agentx-staging-control-plane", slack: "agentx-staging-slack" },
  controlPlaneUrl: "https://abc.execute-api.us-east-1.amazonaws.com",
  identity: { mode: "cognito", issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x", audience: "client", clientId: "client" },
  models: { orchestrator: "us.anthropic.claude-haiku-4-5-20251001-v1:0", classifier: "amazon.nova-lite-v1:0", worker: "amazon.nova-pro-v1:0" },
  updatedAt: "2026-09-26T00:00:00.000Z",
};

describe("environment settings", () => {
  it("uses the shared fixture", () => {
    expect(stagingSettings).toEqual(expectedFixture);
  });

  it("round-trips through /agentx/<env>/settings", async () => {
    const store = new MemoryParameterStore();
    await writeEnvironmentSettings(store, stagingSettings);
    expect(settingsParameterName("staging")).toBe("/agentx/staging/settings");
    expect(store.values.has("/agentx/staging/settings")).toBe(true);
    expect(await readEnvironmentSettings(store, "staging")).toEqual(stagingSettings);
  });

  it("returns undefined for an environment that does not exist", async () => {
    expect(await readEnvironmentSettings(new MemoryParameterStore(), "staging")).toBeUndefined();
  });

  it("refuses stored settings that do not match the schema, naming the environment", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/settings", JSON.stringify({ ...stagingSettings, engine: "terraform" }));
    await expect(readEnvironmentSettings(store, "staging")).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("staging") });
  });

  it("refuses settings whose env does not match the parameter's environment", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/settings", JSON.stringify({ ...stagingSettings, env: "production" }));
    await expect(readEnvironmentSettings(store, "staging")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("refuses to write invalid settings", async () => {
    const store = new MemoryParameterStore();
    await expect(writeEnvironmentSettings(store, { ...stagingSettings, account: "12" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(store.values.size).toBe(0);
  });

  it("never stores a field outside the schema", () => {
    expect(EnvironmentSettingsSchema.safeParse({ ...stagingSettings, slackBotToken: "xoxb-1" }).success).toBe(false);
  });

  it("lists environments that have settings", async () => {
    const store = new MemoryParameterStore();
    await writeEnvironmentSettings(store, stagingSettings);
    await writeEnvironmentSettings(store, { ...stagingSettings, env: "production", stacks: { ...stagingSettings.stacks } });
    store.values.set("/agentx/orphan/lock", "{}");
    expect(await listEnvironments(store)).toEqual(["production", "staging"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/environment-settings.test.ts`
Expected: FAIL, cannot resolve `settings.js`.

- [ ] **Step 3: Implement**

`parameter-store.ts`:

```ts
import { DeleteParameterCommand, GetParameterCommand, GetParametersByPathCommand, PutParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";

export interface ParameterStore {
  get(name: string): Promise<{ value: string; version: number } | undefined>;
  put(name: string, value: string, options?: { createOnly?: boolean }): Promise<void>;
  delete(name: string): Promise<void>;
  list(path: string): Promise<string[]>;
}

export class ParameterExistsError extends Error {
  constructor(name: string) {
    super(`parameter ${name} already exists`);
    this.name = "ParameterExistsError";
  }
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);

export function ssmParameterStore(client: SSMClient): ParameterStore {
  return {
    async get(name) {
      try {
        const { Parameter } = await client.send(new GetParameterCommand({ Name: name }));
        return Parameter?.Value === undefined ? undefined : { value: Parameter.Value, version: Parameter.Version ?? 0 };
      } catch (error) {
        if (errorName(error) === "ParameterNotFound") return undefined;
        throw error;
      }
    },
    async put(name, value, options = {}) {
      try {
        await client.send(new PutParameterCommand({ Name: name, Value: value, Type: "String", Overwrite: !options.createOnly }));
      } catch (error) {
        if (errorName(error) === "ParameterAlreadyExists") throw new ParameterExistsError(name);
        throw error;
      }
    },
    async delete(name) {
      try {
        await client.send(new DeleteParameterCommand({ Name: name }));
      } catch (error) {
        if (errorName(error) !== "ParameterNotFound") throw error;
      }
    },
    async list(path) {
      const names: string[] = [];
      let NextToken: string | undefined;
      do {
        const page = await client.send(new GetParametersByPathCommand({ Path: path, Recursive: true, ...(NextToken ? { NextToken } : {}) }));
        names.push(...(page.Parameters ?? []).flatMap((parameter) => (parameter.Name ? [parameter.Name] : [])));
        NextToken = page.NextToken;
      } while (NextToken);
      return names;
    },
  };
}
```

`settings.ts`: the schema above, plus:

```ts
export function settingsParameterName(env: string): string {
  return `${environmentSettingsPrefix(env)}settings`;
}

export async function readEnvironmentSettings(store: ParameterStore, env: string): Promise<EnvironmentSettings | undefined> {
  const stored = await store.get(settingsParameterName(env));
  if (stored === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(stored.value);
  } catch {
    throw agentXError("CONFIG_INVALID", `settings for environment ${env} are not valid JSON`);
  }
  const parsed = EnvironmentSettingsSchema.safeParse(json);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `settings for environment ${env} are invalid: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}`.trim());
  if (parsed.data.env !== env) throw agentXError("CONFIG_INVALID", `settings stored for environment ${env} name environment ${parsed.data.env}`);
  return parsed.data;
}

export async function writeEnvironmentSettings(store: ParameterStore, settings: EnvironmentSettings): Promise<void> {
  const parsed = EnvironmentSettingsSchema.safeParse(settings);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `environment settings are invalid: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}`.trim());
  await store.put(settingsParameterName(parsed.data.env), JSON.stringify(parsed.data));
}

export async function listEnvironments(store: ParameterStore): Promise<string[]> {
  const names = await store.list("/agentx/");
  return names
    .map((name) => /^\/agentx\/([^/]+)\/settings$/.exec(name)?.[1])
    .filter((env): env is string => env !== undefined && EnvironmentNameSchema.safeParse(env).success)
    .sort();
}
```

`tests/support/memory-parameter-store.ts` implements the same interface over a `Map`, throwing
`ParameterExistsError` on `createOnly` when present, and logging every call to `calls`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/contract/environment-settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/package.json package-lock.json packages/cli/src/environments tests/contract/environment-settings.test.ts tests/support/memory-parameter-store.ts tests/support/environment-fixtures.ts
git commit -m "feat(cli): environment settings in SSM"
```

### Task 7: The environment lock

**Files:**
- Create: `packages/cli/src/environments/lock.ts`
- Test: `tests/contract/environment-lock.test.ts`

**Interfaces:**
- Consumes: Task 6's `ParameterStore`, `ParameterExistsError`, `MemoryParameterStore`.
- Produces:

```ts
export interface LockRecord { holder: string; command: string; acquiredAt: string }
export const STALE_LOCK_MS = 2 * 60 * 60 * 1000;
export function lockParameterName(env: string): string;   // /agentx/<env>/lock
export async function withEnvironmentLock<T>(input: {
  store: ParameterStore;
  env: string;
  holder: string;          // for example the caller ARN from sts:GetCallerIdentity
  command: string;         // for example "env adopt"
  now?: () => number;
  confirmTakeover?: (held: LockRecord) => Promise<boolean>;  // asked only for a stale lock
}, work: () => Promise<T>): Promise<T>;
```

Errors: a fresh lock held by anyone (including the same holder) → `agentXError("CONFIG_INVALID", "environment <env> is locked by <holder> running \"<command>\" since <acquiredAt>")`.
A stale lock with no `confirmTakeover`, or declined → the same message plus
` (older than 2 hours; confirm to take it over)`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { STALE_LOCK_MS, lockParameterName, withEnvironmentLock } from "../../packages/cli/src/environments/lock.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const base = { env: "staging", holder: "arn:aws:iam::123456789012:user/alice", command: "env adopt" };
const t0 = Date.parse("2026-09-26T00:00:00.000Z");

describe("environment lock", () => {
  it("holds the lock while the work runs and releases it afterwards", async () => {
    const store = new MemoryParameterStore();
    const result = await withEnvironmentLock({ ...base, store, now: () => t0 }, async () => {
      expect(JSON.parse(store.values.get(lockParameterName("staging"))!)).toEqual({ holder: base.holder, command: "env adopt", acquiredAt: "2026-09-26T00:00:00.000Z" });
      return 42;
    });
    expect(result).toBe(42);
    expect(store.values.has("/agentx/staging/lock")).toBe(false);
  });

  it("releases the lock when the work fails", async () => {
    const store = new MemoryParameterStore();
    await expect(withEnvironmentLock({ ...base, store }, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(store.values.has("/agentx/staging/lock")).toBe(false);
  });

  it("refuses a fresh lock and names its holder, without running the work", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/lock", JSON.stringify({ holder: "bob", command: "upgrade", acquiredAt: new Date(t0 - 60_000).toISOString() }));
    const work = vi.fn(async () => 1);
    await expect(withEnvironmentLock({ ...base, store, now: () => t0 }, work))
      .rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("locked by bob running \"upgrade\"") });
    expect(work).not.toHaveBeenCalled();
    expect(store.values.has("/agentx/staging/lock")).toBe(true);
  });

  it("does not offer takeover of a fresh lock", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/lock", JSON.stringify({ holder: "bob", command: "upgrade", acquiredAt: new Date(t0 - 60_000).toISOString() }));
    const confirmTakeover = vi.fn(async () => true);
    await expect(withEnvironmentLock({ ...base, store, now: () => t0, confirmTakeover }, async () => 1)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(confirmTakeover).not.toHaveBeenCalled();
  });

  it("takes over a stale lock only after confirmation", async () => {
    const store = new MemoryParameterStore();
    const stale = { holder: "bob", command: "upgrade", acquiredAt: new Date(t0 - STALE_LOCK_MS - 1).toISOString() };
    store.values.set("/agentx/staging/lock", JSON.stringify(stale));
    await expect(withEnvironmentLock({ ...base, store, now: () => t0, confirmTakeover: async () => false }, async () => 1))
      .rejects.toMatchObject({ message: expect.stringContaining("older than 2 hours") });
    const confirmTakeover = vi.fn(async () => true);
    expect(await withEnvironmentLock({ ...base, store, now: () => t0, confirmTakeover }, async () => 7)).toBe(7);
    expect(confirmTakeover).toHaveBeenCalledWith(stale);
  });

  it("treats an unreadable lock as held, not as free", async () => {
    const store = new MemoryParameterStore();
    store.values.set("/agentx/staging/lock", "not json");
    await expect(withEnvironmentLock({ ...base, store, now: () => t0 }, async () => 1)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/environment-lock.test.ts`
Expected: FAIL, cannot resolve `lock.js`.

- [ ] **Step 3: Implement**

```ts
import { agentXError } from "@agentx/contracts";
import { environmentSettingsPrefix } from "@agentx/contracts";
import { ParameterExistsError, type ParameterStore } from "./parameter-store.js";

export interface LockRecord { holder: string; command: string; acquiredAt: string }
export const STALE_LOCK_MS = 2 * 60 * 60 * 1000;

export function lockParameterName(env: string): string {
  return `${environmentSettingsPrefix(env)}lock`;
}

function parseLock(value: string): LockRecord | undefined {
  try {
    const record = JSON.parse(value) as Partial<LockRecord>;
    if (typeof record.holder === "string" && typeof record.command === "string" && typeof record.acquiredAt === "string" && !Number.isNaN(Date.parse(record.acquiredAt))) {
      return record as LockRecord;
    }
  } catch { /* fall through */ }
  return undefined;
}

export async function withEnvironmentLock<T>(input: {
  store: ParameterStore; env: string; holder: string; command: string;
  now?: () => number; confirmTakeover?: (held: LockRecord) => Promise<boolean>;
}, work: () => Promise<T>): Promise<T> {
  const now = input.now ?? Date.now;
  const name = lockParameterName(input.env);
  const mine: LockRecord = { holder: input.holder, command: input.command, acquiredAt: new Date(now()).toISOString() };
  try {
    await input.store.put(name, JSON.stringify(mine), { createOnly: true });
  } catch (error) {
    if (!(error instanceof ParameterExistsError)) throw error;
    const stored = await input.store.get(name);
    const held = stored === undefined ? undefined : parseLock(stored.value);
    if (held === undefined) {
      throw agentXError("CONFIG_INVALID", `environment ${input.env} is locked by an unreadable lock at ${name}; remove it only if no AgentX command is running`);
    }
    const message = `environment ${input.env} is locked by ${held.holder} running "${held.command}" since ${held.acquiredAt}`;
    const stale = now() - Date.parse(held.acquiredAt) > STALE_LOCK_MS;
    if (!stale) throw agentXError("CONFIG_INVALID", message);
    if (!input.confirmTakeover || !(await input.confirmTakeover(held))) {
      throw agentXError("CONFIG_INVALID", `${message} (older than 2 hours; confirm to take it over)`);
    }
    await input.store.put(name, JSON.stringify(mine));
  }
  try {
    return await work();
  } finally {
    await input.store.delete(name);
  }
}
```

(Merge the two `@agentx/contracts` imports into one.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/contract/environment-lock.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/environments/lock.ts tests/contract/environment-lock.test.ts
git commit -m "feat(cli): environment lock in SSM"
```

### Task 8: `--env`, the local cache, and `agentx env list` / `env use`

**Files:**
- Create: `packages/cli/src/environments/cache.ts`
- Create: `packages/cli/src/environments/commands.ts`
- Modify: `packages/cli/src/main.ts` (global `--env`, deployment file resolution, `env` command group, `CliDependencies.environments`)
- Modify: `packages/cli/src/deployment.ts` (optional `env` field on the cached file)
- Test: `tests/contract/environment-cli.test.ts`

**Interfaces:**
- Consumes: Task 6's `readEnvironmentSettings`, `listEnvironments`, `EnvironmentSettings`, `ParameterStore`; Task 1's `DEFAULT_ENVIRONMENT`, `EnvironmentNameSchema`.
- Produces:

```ts
// cache.ts
export function environmentCachePath(home: string, env: string): string;  // <home>/.agentx/environments/<env>.yaml
export function cacheFromSettings(settings: EnvironmentSettings): DeploymentSettings & { env: string };
export async function writeEnvironmentCache(home: string, settings: EnvironmentSettings): Promise<string>;  // returns the path; writes 0600 via temp file + rename
/** Explicit --deployment-file wins; then the environment cache; then, for production only, the legacy ~/.agentx/deployment.yaml. */
export async function resolveDeploymentFile(input: { home: string; env: string; explicitFile?: string }): Promise<string>;

// commands.ts
export async function runEnvList(store: ParameterStore): Promise<string[]>;
export async function runEnvUse(input: { store: ParameterStore; home: string; env: string }): Promise<{ env: string; path: string; controlPlaneUrl: string }>;

// main.ts
export interface CliDependencies {
  // ... existing
  environments?: { store?: ParameterStore; home?: string; sts?: CallerIdentity; stacks?: StackReader };
}
```

`DeploymentSettingsSchema` gains `env: EnvironmentNameSchema.optional()`. `loadDeploymentSettings`
gains an optional `expectedEnv?: string`; when the file has an `env` that differs from
`expectedEnv`, it throws `CONFIG_INVALID` "deployment file <path> is for environment <a>, not <b>;
run agentx env use <b>". A file with no `env` (the legacy file) is accepted.

The `--deployment-file` option loses its default value, so the CLI can tell when it was given.
Every existing command resolves its file through `resolveDeploymentFile`. With no `--env`, no
`--deployment-file` and only the legacy `~/.agentx/deployment.yaml` present, behavior is exactly
as today.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { environmentCachePath, resolveDeploymentFile } from "../../packages/cli/src/environments/cache.js";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { stagingSettings } from "../support/environment-fixtures.js";

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentx-env-cli-"));
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: { write: (t: string) => out.push(t) }, stderr: { write: (t: string) => err.push(t) } };
}

describe("agentx env", () => {
  it("lists environments from SSM", async () => {
    const store = new MemoryParameterStore();
    await writeEnvironmentSettings(store, stagingSettings);
    const io = capture();
    const code = await executeCli(["node", "agentx", "--json", "env", "list"], { ...io, environments: { store, home: await home() } });
    expect(code).toBe(0);
    expect(JSON.parse(io.out.join(""))).toMatchObject({ environments: ["staging"] });
  });

  it("use writes the environment cache from SSM with owner-only permissions", async () => {
    const store = new MemoryParameterStore();
    await writeEnvironmentSettings(store, stagingSettings);
    const dir = await home();
    const io = capture();
    const code = await executeCli(["node", "agentx", "--env", "staging", "env", "use"], { ...io, environments: { store, home: dir } });
    expect(code).toBe(0);
    const path = environmentCachePath(dir, "staging");
    const text = await readFile(path, "utf8");
    expect(text).toContain("env: staging");
    expect(text).toContain(stagingSettings.controlPlaneUrl);
    expect(text).toContain(`clientId: ${stagingSettings.identity.clientId}`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("use explains how to install when the environment does not exist", async () => {
    const io = capture();
    const code = await executeCli(["node", "agentx", "--env", "nope", "env", "use"], { ...io, environments: { store: new MemoryParameterStore(), home: await home() } });
    expect(code).not.toBe(0);
    expect(io.err.join("")).toContain("environment nope is not installed in this account and region");
  });

  it("refuses an invalid --env before calling AWS", async () => {
    const store = new MemoryParameterStore();
    const io = capture();
    const code = await executeCli(["node", "agentx", "--env", "Prod", "env", "use"], { ...io, environments: { store, home: await home() } });
    expect(code).not.toBe(0);
    expect(store.calls).toEqual([]);
  });
});

describe("deployment file resolution", () => {
  it("prefers an explicit file, then the environment cache, then the legacy file for production only", async () => {
    const dir = await home();
    await mkdir(join(dir, ".agentx", "environments"), { recursive: true });
    const legacy = join(dir, ".agentx", "deployment.yaml");
    await writeFile(legacy, "x");
    expect(await resolveDeploymentFile({ home: dir, env: "production", explicitFile: "/tmp/explicit.yaml" })).toBe("/tmp/explicit.yaml");
    expect(await resolveDeploymentFile({ home: dir, env: "production" })).toBe(legacy);
    await writeFile(environmentCachePath(dir, "production"), "x");
    expect(await resolveDeploymentFile({ home: dir, env: "production" })).toBe(environmentCachePath(dir, "production"));
    await expect(resolveDeploymentFile({ home: dir, env: "staging" })).rejects.toMatchObject({ message: expect.stringContaining("agentx --env staging env use") });
  });

  it("refuses a cache written for another environment", async () => {
    const dir = await home();
    await mkdir(join(dir, ".agentx", "environments"), { recursive: true });
    const path = environmentCachePath(dir, "staging");
    await writeFile(path, [
      "env: production",
      "controlPlaneUrl: https://abc.execute-api.us-east-1.amazonaws.com",
      "auth:",
      "  issuer: https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x",
      "  clientId: client",
      "  audience: client",
      "",
    ].join("\n"));
    const io = capture();
    const code = await executeCli(["node", "agentx", "--env", "staging", "--json", "login"], { ...io, environments: { store: new MemoryParameterStore(), home: dir } });
    expect(code).not.toBe(0);
    expect(io.err.join("") + io.out.join("")).toContain("is for environment production, not staging");
  });
});
```

Read `executeCli`'s signature in `main.ts` first; if it differs from
`executeCli(argv, dependencies)`, adapt the calls in this test to it (not the other way round).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/environment-cli.test.ts`
Expected: FAIL, cannot resolve `cache.js`.

- [ ] **Step 3: Implement `cache.ts`**

```ts
import { access, mkdir, open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agentXError } from "@agentx/contracts";
import YAML from "yaml";
import type { DeploymentSettings } from "../deployment.js";
import type { EnvironmentSettings } from "./settings.js";

export function environmentCachePath(home: string, env: string): string {
  return join(home, ".agentx", "environments", `${env}.yaml`);
}

export function cacheFromSettings(settings: EnvironmentSettings): DeploymentSettings & { env: string } {
  return {
    env: settings.env,
    controlPlaneUrl: settings.controlPlaneUrl,
    auth: { issuer: settings.identity.issuer, clientId: settings.identity.clientId, audience: settings.identity.audience },
  };
}

export async function writeEnvironmentCache(home: string, settings: EnvironmentSettings): Promise<string> {
  const path = environmentCachePath(home, settings.env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`# AgentX environment ${settings.env}; rebuilt from SSM by agentx env use.\n${YAML.stringify(cacheFromSettings(settings))}`);
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  return path;
}

const exists = (path: string) => access(path).then(() => true, () => false);

export async function resolveDeploymentFile(input: { home: string; env: string; explicitFile?: string }): Promise<string> {
  if (input.explicitFile !== undefined) return input.explicitFile;
  const cached = environmentCachePath(input.home, input.env);
  if (await exists(cached)) return cached;
  const legacy = join(input.home, ".agentx", "deployment.yaml");
  if (input.env === "production" && (await exists(legacy))) return legacy;
  throw agentXError("CONFIG_INVALID", `no settings for environment ${input.env} on this machine; run agentx --env ${input.env} env use`);
}
```

- [ ] **Step 4: Implement `commands.ts` and wire `main.ts`**

```ts
import { agentXError } from "@agentx/contracts";
import { writeEnvironmentCache } from "./cache.js";
import type { ParameterStore } from "./parameter-store.js";
import { listEnvironments, readEnvironmentSettings } from "./settings.js";

export async function runEnvList(store: ParameterStore): Promise<string[]> {
  return listEnvironments(store);
}

export async function runEnvUse(input: { store: ParameterStore; home: string; env: string }) {
  const settings = await readEnvironmentSettings(input.store, input.env);
  if (settings === undefined) {
    throw agentXError("CONFIG_INVALID", `environment ${input.env} is not installed in this account and region; check your AWS profile and region, or install it with agentx init --env ${input.env}`);
  }
  const path = await writeEnvironmentCache(input.home, settings);
  return { env: settings.env, path, controlPlaneUrl: settings.controlPlaneUrl };
}
```

In `main.ts`:
- Add the global option `.option("--env <name>", "AgentX environment", DEFAULT_ENVIRONMENT)` and
  remove the default from `--deployment-file`. Validate `--env` with `EnvironmentNameSchema` in a
  `preAction` hook, failing with `CONFIG_INVALID` before any command runs.
- Where the CLI loads deployment settings today, first call
  `resolveDeploymentFile({ home, env: options.env, ...(options.deploymentFile ? { explicitFile: options.deploymentFile } : {}) })`
  and pass `expectedEnv: options.env` to `loadDeploymentSettings`.
- Add `const envCommand = program.command("env").description("AgentX environments in this AWS account and region");`
  with `list` (prints the names, or `{ environments }` with `--json`) and `use` (prints
  "Using environment <env> (<controlPlaneUrl>); settings saved to <path>"). The store comes from
  `dependencies.environments?.store ?? ssmParameterStore(new SSMClient({}))`; `home` from
  `dependencies.environments?.home ?? homedir()`.

In `deployment.ts`, add `env: EnvironmentNameSchema.optional()` to the schema and the
`expectedEnv` check described in Interfaces.

- [ ] **Step 5: Run the new test and every CLI test**

Run: `npx vitest run tests/contract/environment-cli.test.ts tests/contract/cli-main.test.ts tests/contract/cli-execution.test.ts tests/contract/deployment-settings.test.ts tests/contract/credential-cli.test.ts tests/contract/slack-admin-cli.test.ts tests/contract/turns-cli.test.ts`
Expected: PASS, existing tests unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src tests/contract/environment-cli.test.ts
git commit -m "feat(cli): --env, per-environment settings cache, env list and env use"
```

### Task 9: `agentx env adopt`

**Files:**
- Create: `packages/cli/src/environments/adopt.ts`
- Modify: `packages/cli/src/environments/commands.ts` (`runEnvAdopt`)
- Modify: `packages/cli/src/main.ts` (`env adopt` subcommand)
- Modify: `packages/cli/package.json` (add `"@aws-sdk/client-cloudformation": "3.1134.0"` and `"@aws-sdk/client-sts": "3.1134.0"`), then `npm install`
- Modify: `docs/architecture-production.md` (a short "Environments" section)
- Test: `tests/contract/environment-adopt.test.ts`

**Interfaces:**
- Consumes: Task 3's `LEGACY_STACK_NAMES` (import from `infra/lib/naming.ts` is not allowed in the
  CLI package; copy the four names into `adopt.ts` as `ADOPTED_STACK_NAMES` and add a test that
  compares the two), Task 6's settings, Task 7's `withEnvironmentLock`, Task 8's `writeEnvironmentCache`.
- Produces:

```ts
export interface StackReader {
  /** DescribeStacks for one stack; undefined when it does not exist. */
  describe(stackName: string): Promise<{ outputs: Record<string, string>; parameters: Record<string, string>; status: string } | undefined>;
}
export interface CallerIdentity { get(): Promise<{ account: string; arn: string }> }
export function cloudFormationStackReader(client: CloudFormationClient): StackReader;
export function stsCallerIdentity(client: STSClient): CallerIdentity;
export async function adoptEnvironment(input: {
  env: string; region: string; clientId?: string;
  stacks: StackReader; identity: CallerIdentity; store: ParameterStore; home: string;
  now?: () => number;
}): Promise<EnvironmentSettings>;
```

What adopt reads, exactly:
- account from `identity.get().account`;
- `AgentXControlPlane` output `ApiEndpoint` → `controlPlaneUrl`; parameters `OidcIssuer`,
  `OidcAudience` → identity issuer and audience;
- `clientId` from `--client-id`, else the audience (a Cognito app client's audience is its ID);
- identity mode `cognito` when the issuer starts with `https://cognito-idp.`, else `oidc`;
- `AgentXSlackOrchestrator` parameters `ModelId` → `models.orchestrator`, `GateClassifierModelId`
  → `models.classifier`;
- `AgentXProductionRuntime` parameter `ModelId` → `models.worker`;
- `AgentXProductionFoundation` must exist.

It writes `engine: "cdk"`, `version: "unversioned"`, `naming: "legacy"`, the four legacy stack names,
`updatedAt: now`. Any missing stack, a stack whose status ends in `_FAILED` or is
`ROLLBACK_COMPLETE`, or a missing output or parameter → `CONFIG_INVALID` naming the stack and the
missing item, and nothing written. An environment that already has settings → `CONFIG_INVALID`
"environment <env> already has settings; nothing changed". The write happens inside
`withEnvironmentLock` with `command: "env adopt"` and `holder` = the caller ARN.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEGACY_STACK_NAMES } from "../../infra/lib/naming.js";
import { ADOPTED_STACK_NAMES, adoptEnvironment, type StackReader } from "../../packages/cli/src/environments/adopt.js";
import { readEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const liveStacks: Record<string, { outputs: Record<string, string>; parameters: Record<string, string>; status: string }> = {
  AgentXProductionFoundation: { outputs: {}, parameters: {}, status: "UPDATE_COMPLETE" },
  AgentXProductionRuntime: { outputs: {}, parameters: { ModelId: "amazon.nova-pro-v1:0" }, status: "UPDATE_COMPLETE" },
  AgentXControlPlane: {
    outputs: { ApiEndpoint: "https://abc.execute-api.us-east-1.amazonaws.com" },
    parameters: { OidcIssuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x", OidcAudience: "client123" },
    status: "UPDATE_COMPLETE",
  },
  AgentXSlackOrchestrator: { outputs: {}, parameters: { ModelId: "amazon.nova-pro-v1:0", GateClassifierModelId: "amazon.nova-lite-v1:0" }, status: "UPDATE_COMPLETE" },
};

function reader(stacks: typeof liveStacks, log: string[] = []): StackReader {
  return { describe: async (name) => { log.push(name); return stacks[name]; } };
}

const identity = { get: async () => ({ account: "944937319445", arn: "arn:aws:iam::944937319445:user/admin" }) };
const now = () => Date.parse("2026-09-26T00:00:00.000Z");

async function run(stacks = liveStacks, store = new MemoryParameterStore()) {
  const home = await mkdtemp(join(tmpdir(), "agentx-adopt-"));
  return { store, home, result: adoptEnvironment({ env: "production", region: "us-east-1", stacks: reader(stacks), identity, store, home, now }) };
}

describe("agentx env adopt", () => {
  it("uses the same stack names as the infra's legacy naming", () => {
    expect(ADOPTED_STACK_NAMES).toEqual(LEGACY_STACK_NAMES);
  });

  it("registers the existing deployment from its stacks without changing them", async () => {
    const { store, result } = await run();
    const settings = await result;
    expect(settings).toEqual({
      schemaVersion: 1,
      env: "production",
      account: "944937319445",
      region: "us-east-1",
      engine: "cdk",
      version: "unversioned",
      naming: "legacy",
      stacks: { foundation: "AgentXProductionFoundation", runtime: "AgentXProductionRuntime", "control-plane": "AgentXControlPlane", slack: "AgentXSlackOrchestrator" },
      controlPlaneUrl: "https://abc.execute-api.us-east-1.amazonaws.com",
      identity: { mode: "cognito", issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x", audience: "client123", clientId: "client123" },
      models: { orchestrator: "amazon.nova-pro-v1:0", classifier: "amazon.nova-lite-v1:0", worker: "amazon.nova-pro-v1:0" },
      updatedAt: "2026-09-26T00:00:00.000Z",
    });
    expect(await readEnvironmentSettings(store, "production")).toEqual(settings);
    expect(store.values.has("/agentx/production/lock")).toBe(false);
    expect(store.calls.every((call) => call.name.startsWith("/agentx/production/"))).toBe(true);
  });

  it("refuses and writes nothing when a stack is missing", async () => {
    const { AgentXSlackOrchestrator: _missing, ...rest } = liveStacks;
    const { store, result } = await run(rest as typeof liveStacks);
    await expect(result).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("AgentXSlackOrchestrator") });
    expect(store.values.has("/agentx/production/settings")).toBe(false);
  });

  it("refuses and writes nothing when an output is missing", async () => {
    const stacks = { ...liveStacks, AgentXControlPlane: { ...liveStacks.AgentXControlPlane!, outputs: {} } };
    const { store, result } = await run(stacks);
    await expect(result).rejects.toMatchObject({ message: expect.stringContaining("ApiEndpoint") });
    expect(store.values.has("/agentx/production/settings")).toBe(false);
  });

  it("refuses a stack in a failed state", async () => {
    const stacks = { ...liveStacks, AgentXProductionRuntime: { ...liveStacks.AgentXProductionRuntime!, status: "UPDATE_ROLLBACK_FAILED" } };
    await expect((await run(stacks)).result).rejects.toMatchObject({ message: expect.stringContaining("AgentXProductionRuntime") });
  });

  it("refuses an environment that already has settings, changing nothing", async () => {
    const store = new MemoryParameterStore();
    await (await run(liveStacks, store)).result;
    const before = store.values.get("/agentx/production/settings");
    await expect((await run(liveStacks, store)).result).rejects.toMatchObject({ message: expect.stringContaining("already has settings") });
    expect(store.values.get("/agentx/production/settings")).toBe(before);
  });

  it("marks a non-Cognito issuer as oidc and uses --client-id", async () => {
    const stacks = { ...liveStacks, AgentXControlPlane: { ...liveStacks.AgentXControlPlane!, parameters: { OidcIssuer: "https://login.example.com", OidcAudience: "api://agentx" } } };
    const home = await mkdtemp(join(tmpdir(), "agentx-adopt-"));
    const settings = await adoptEnvironment({ env: "production", region: "us-east-1", clientId: "cli-client", stacks: reader(stacks), identity, store: new MemoryParameterStore(), home, now });
    expect(settings.identity).toEqual({ mode: "oidc", issuer: "https://login.example.com", audience: "api://agentx", clientId: "cli-client" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contract/environment-adopt.test.ts`
Expected: FAIL, cannot resolve `adopt.js`.

- [ ] **Step 3: Implement `adopt.ts`**

```ts
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { GetCallerIdentityCommand, type STSClient } from "@aws-sdk/client-sts";
import { agentXError, type StackPart } from "@agentx/contracts";
import { writeEnvironmentCache } from "./cache.js";
import { withEnvironmentLock } from "./lock.js";
import type { ParameterStore } from "./parameter-store.js";
import { readEnvironmentSettings, writeEnvironmentSettings, type EnvironmentSettings } from "./settings.js";

/** Must equal infra/lib/naming.ts LEGACY_STACK_NAMES (a test compares them). */
export const ADOPTED_STACK_NAMES: Record<StackPart, string> = {
  foundation: "AgentXProductionFoundation",
  runtime: "AgentXProductionRuntime",
  "control-plane": "AgentXControlPlane",
  slack: "AgentXSlackOrchestrator",
};

export interface StackDescription { outputs: Record<string, string>; parameters: Record<string, string>; status: string }
export interface StackReader { describe(stackName: string): Promise<StackDescription | undefined> }
export interface CallerIdentity { get(): Promise<{ account: string; arn: string }> }

export function cloudFormationStackReader(client: CloudFormationClient): StackReader {
  return {
    async describe(stackName) {
      try {
        const { Stacks } = await client.send(new DescribeStacksCommand({ StackName: stackName }));
        const stack = Stacks?.[0];
        if (!stack) return undefined;
        return {
          status: stack.StackStatus ?? "UNKNOWN",
          outputs: Object.fromEntries((stack.Outputs ?? []).flatMap((o) => (o.OutputKey && o.OutputValue !== undefined ? [[o.OutputKey, o.OutputValue]] : []))),
          parameters: Object.fromEntries((stack.Parameters ?? []).flatMap((p) => (p.ParameterKey && p.ParameterValue !== undefined ? [[p.ParameterKey, p.ParameterValue]] : []))),
        };
      } catch (error) {
        if (error instanceof Error && error.name === "ValidationError" && /does not exist/.test(error.message)) return undefined;
        throw error;
      }
    },
  };
}

export function stsCallerIdentity(client: STSClient): CallerIdentity {
  return {
    async get() {
      const { Account, Arn } = await client.send(new GetCallerIdentityCommand({}));
      if (!Account || !Arn) throw agentXError("RUNTIME_UNAVAILABLE", "AWS did not return the caller identity");
      return { account: Account, arn: Arn };
    },
  };
}

async function healthyStack(stacks: StackReader, name: string): Promise<StackDescription> {
  const stack = await stacks.describe(name);
  if (stack === undefined) throw agentXError("CONFIG_INVALID", `stack ${name} was not found in this account and region; nothing changed`);
  if (stack.status.endsWith("_FAILED") || stack.status === "ROLLBACK_COMPLETE") {
    throw agentXError("CONFIG_INVALID", `stack ${name} is ${stack.status}; fix it before adopting; nothing changed`);
  }
  return stack;
}

function required(stack: StackDescription, stackName: string, kind: "outputs" | "parameters", key: string): string {
  const value = stack[kind][key];
  if (value === undefined || value === "") {
    throw agentXError("CONFIG_INVALID", `stack ${stackName} has no ${kind === "outputs" ? "output" : "parameter"} ${key}; nothing changed`);
  }
  return value;
}

export async function adoptEnvironment(input: {
  env: string; region: string; clientId?: string;
  stacks: StackReader; identity: CallerIdentity; store: ParameterStore; home: string; now?: () => number;
}): Promise<EnvironmentSettings> {
  const now = input.now ?? Date.now;
  const caller = await input.identity.get();
  return withEnvironmentLock({ store: input.store, env: input.env, holder: caller.arn, command: "env adopt", now }, async () => {
    if ((await readEnvironmentSettings(input.store, input.env)) !== undefined) {
      throw agentXError("CONFIG_INVALID", `environment ${input.env} already has settings; nothing changed`);
    }
    const names = ADOPTED_STACK_NAMES;
    await healthyStack(input.stacks, names.foundation);
    const runtime = await healthyStack(input.stacks, names.runtime);
    const control = await healthyStack(input.stacks, names["control-plane"]);
    const slack = await healthyStack(input.stacks, names.slack);
    const issuer = required(control, names["control-plane"], "parameters", "OidcIssuer");
    const audience = required(control, names["control-plane"], "parameters", "OidcAudience");
    const settings: EnvironmentSettings = {
      schemaVersion: 1,
      env: input.env,
      account: caller.account,
      region: input.region,
      engine: "cdk",
      version: "unversioned",
      naming: "legacy",
      stacks: { ...names },
      controlPlaneUrl: required(control, names["control-plane"], "outputs", "ApiEndpoint"),
      identity: { mode: issuer.startsWith("https://cognito-idp.") ? "cognito" : "oidc", issuer, audience, clientId: input.clientId ?? audience },
      models: {
        orchestrator: required(slack, names.slack, "parameters", "ModelId"),
        classifier: required(slack, names.slack, "parameters", "GateClassifierModelId"),
        worker: required(runtime, names.runtime, "parameters", "ModelId"),
      },
      updatedAt: new Date(now()).toISOString(),
    };
    await writeEnvironmentSettings(input.store, settings);
    await writeEnvironmentCache(input.home, settings);
    return settings;
  });
}
```

- [ ] **Step 4: Wire the command and the docs**

In `commands.ts` add `runEnvAdopt` that builds the AWS clients (or takes them from
`CliDependencies.environments`) and calls `adoptEnvironment` with the region from
`--region` (required option on `env adopt`) and optional `--client-id`. In `main.ts` add
`env adopt --region <region> [--client-id <id>]`, printing "Adopted <env>: <controlPlaneUrl>;
settings in /agentx/<env>/settings".

Append to `docs/architecture-production.md` a section "Environments" (under 25 lines) covering:
what an environment is; the naming table from Global Constraints; that the deployment which
predates environments keeps its fixed names and is registered with
`agentx --env production env adopt --region us-east-1`; `env list` and `env use`; the lock.

- [ ] **Step 5: Run the tests, then the full gate**

Run: `npx vitest run tests/contract/environment-adopt.test.ts tests/contract/environment-cli.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`
Expected: all pass; the legacy snapshots are unchanged. If a CDK packaging test times out under
load (issue #59), rerun that file alone and record both runs.

- [ ] **Step 6: Commit**

```bash
git add packages/cli docs/architecture-production.md package-lock.json tests/contract/environment-adopt.test.ts
git commit -m "feat(cli): agentx env adopt registers an existing deployment"
```

### Task 10: Live check (owner present)

This task makes no code change. It needs the owner's approval, because it writes to SSM in the
production account. It uses the approved profile `charterarc-audit-codex` in `us-east-1`.

- [ ] **Step 1: Confirm the profile can do what adopt needs**

Run: `aws sts get-caller-identity --profile charterarc-audit-codex` and
`aws ssm get-parameters-by-path --path /agentx/ --recursive --profile charterarc-audit-codex --region us-east-1`
Expected: the account is 944937319445; the SSM call either lists nothing or fails with
AccessDenied. On AccessDenied, give the owner the exact policy to add (SSM `GetParameter`,
`PutParameter`, `DeleteParameter`, `GetParametersByPath` on
`arn:aws:ssm:us-east-1:944937319445:parameter/agentx/*`) and wait.

- [ ] **Step 2: Adopt production**

Run: `node packages/cli/dist/main.js --env production env adopt --region us-east-1` with
`AWS_PROFILE=charterarc-audit-codex AWS_REGION=us-east-1`.
Expected: "Adopted production: https://3m38w35kz2.execute-api.us-east-1.amazonaws.com"; the
settings show `naming: legacy`, `engine: cdk`, and the current models.

- [ ] **Step 3: Prove nothing changed and the cache works**

Run: `aws cloudformation describe-stacks --profile charterarc-audit-codex --region us-east-1 --query "Stacks[?starts_with(StackName,'AgentX')].[StackName,LastUpdatedTime]" --output text`
Expected: the same `LastUpdatedTime` values as before Step 2.

Run: `node packages/cli/dist/main.js --env production env use`, then
`node packages/cli/dist/main.js --env production admin turns export --since 1h` (after
`agentx login` in the background if the admin token has expired).
Expected: the cache is written, and the export works through it.

- [ ] **Step 4: Record the evidence**

Write the commands and outcomes into this phase's SDD ledger and the PR description.
