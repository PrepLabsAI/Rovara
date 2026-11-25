// F1 lane L1a-0: the install rows are checked against the templates themselves. Every parameter an environment stack declares has a row (a leaked `new CfnParameter` with no row fails by
// logical id), every row's `declaredIn` says what the named and the legacy layout declare today, and each row's type and default are what the template says. Nothing here changes a template.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { INSTALL_ROWS, STACK_PARTS, settingTypeOfTemplateParameter, type StackPart } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Definition = { Type?: string; Default?: string | number; AllowedValues?: unknown[]; MinValue?: number; MaxValue?: number; MaxLength?: number; AllowedPattern?: string };
type Parameters = Record<string, Definition>;

/** A template's own parameters: not CDK's bootstrap version, not a code asset's. */
const declared = (stack: Stack): Parameters => Object.fromEntries(Object.entries((Template.fromStack(stack).toJSON() as { Parameters?: Parameters }).Parameters ?? {}).filter(([name]) => name !== "BootstrapVersion" && !name.startsWith("AssetParameters")));
const stacks = (context: Record<string, unknown>) => buildAgentXApp(context).node.children.filter((child): child is Stack => Stack.isStack(child));

// The release's own context: a named environment with the gateway host (the context that sets CoreAgentModel's pattern).
const named = new Map<StackPart, Parameters>(stacks({ agentxEnv: "staging", CoreModelGatewayHost: "gateway.example" }).flatMap((stack) => {
  const part = STACK_PARTS.find((each) => stack.stackName === `agentx-staging-${each}`);
  return part === undefined ? [] : [[part, declared(stack)] as const];
}));
const LEGACY_STACK: Partial<Record<StackPart, string>> = { "control-plane": "AgentXControlPlane", foundation: "AgentXProductionFoundation", runtime: "AgentXProductionRuntime", slack: "AgentXSlackOrchestrator" };
const legacy = new Map<StackPart, Parameters>(stacks({}).flatMap((stack) => {
  const part = STACK_PARTS.find((each) => LEGACY_STACK[each] === stack.stackName);
  return part === undefined ? [] : [[part, declared(stack)] as const];
}));

/** Every (part, parameter) a row sets, primary and copies. */
const rowParameters = (part: StackPart) => INSTALL_ROWS.flatMap((row) => {
  if (row.install.parameter === undefined) return [];
  const all = [{ part: row.install.part, parameter: row.install.parameter }, ...(row.install.also ?? [])];
  return all.filter((each) => each.part === part).map((each) => ({ parameter: each.parameter, row }));
});

describe("the install rows against the synthesised templates (F1 L1a-0)", () => {
  it("synthesises every environment stack in both layouts", () => {
    expect([...named.keys()].sort()).toEqual([...STACK_PARTS].sort());
    expect([...legacy.keys()].sort()).toEqual(Object.keys(LEGACY_STACK).sort());
  });

  it.each(STACK_PARTS)("has a row for every parameter the named %s stack declares, and no row for one it does not (unless the row says so)", (part) => {
    const inRows = new Set(rowParameters(part).filter(({ row }) => row.install.declaredIn === "named" || row.install.declaredIn === "both").map((each) => each.parameter));
    expect([...inRows].sort()).toEqual(Object.keys(named.get(part)!).sort());
  });

  it.each(Object.keys(LEGACY_STACK) as StackPart[])("has a row for every parameter the legacy %s stack declares, and says which rows the legacy stack lacks", (part) => {
    const inRows = new Set(rowParameters(part).filter(({ row }) => row.install.declaredIn === "legacy" || row.install.declaredIn === "both").map((each) => each.parameter));
    expect([...inRows].sort()).toEqual(Object.keys(legacy.get(part)!).sort());
  });

  it("marks a name no template declares as `neither` (the legacy install's layout literal and G1's relay constant, neither a parameter: TaskPersonProofEnabled was deleted on code/next by 356c3ae57)", () => {
    const neither = INSTALL_ROWS.filter((row) => row.install.declaredIn === "neither").map((row) => row.install.parameter ?? row.key);
    expect(neither.sort()).toEqual(["core.outboxStreamRelay", "install.layout"]);
    for (const row of INSTALL_ROWS) {
      if (row.install.parameter === undefined) continue;
      const inNamed = named.get(row.install.part)?.[row.install.parameter] !== undefined;
      const inLegacy = legacy.get(row.install.part)?.[row.install.parameter] !== undefined;
      const expected = inNamed && inLegacy ? "both" : inNamed ? "named" : inLegacy ? "legacy" : "neither";
      expect(row.install.declaredIn, row.key).toBe(expected);
    }
  });

  it("holds each row's type and default to the named template's", () => {
    for (const row of INSTALL_ROWS) {
      const definition = row.install.parameter === undefined ? undefined : named.get(row.install.part)?.[row.install.parameter];
      if (definition === undefined) continue;
      expect(row.type, row.key).toEqual(settingTypeOfTemplateParameter(definition));
      expect(row.default, row.key).toBe(definition.Default === undefined ? "REQUIRED" : String(definition.Default));
    }
  });

  it("marks every NoEcho parameter secret, and only those", () => {
    for (const row of INSTALL_ROWS) {
      if (row.install.parameter === undefined) continue;
      const definition = named.get(row.install.part)?.[row.install.parameter] as (Definition & { NoEcho?: boolean }) | undefined;
      expect(row.install.secret === true, row.key).toBe(definition?.NoEcho === true);
    }
  });
});
