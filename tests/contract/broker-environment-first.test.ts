// ENV-ROOM: a named environment's broker is given its names and settings packed, and broker-environment-init.ts unpacks them. Nothing may
// read a packed or derived name before that: it would see nothing, and fail only on the Lambda. So the init import is broker.ts's first import, and this loads the real broker.ts
// with only what the control plane passes set, and a process.env that records every read of a packed or derived name before the unpacking starts.
import { readFileSync } from "node:fs";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BROKER_NAMES, BROKER_SETTINGS, DERIVED_BROKER_VARIABLES } from "@agentx/contracts";
import type * as BrokerEnvironment from "../../packages/broker/src/aws/broker-environment.js";
import { loadBrokerNamesParameter } from "../../packages/broker/src/aws/broker-names-parameter.js";
import { brokerNamesParameterOf } from "../support/broker-environment-template.js";
import { RESOLVER_REGION, controlPlaneOf } from "../support/lambda-environment-size.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

/** The named control plane, synthesized (the measure itself, tests/support/lambda-environment-size.ts, takes the template). */
function synthesized(env: string): { template: unknown; stackName: string } {
  const stack = buildAgentXApp({ agentxEnv: env }).node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
  if (stack === undefined) throw new Error("no control plane stack");
  return { template: Template.fromStack(stack).toJSON(), stackName: stack.stackName };
}

const hydration = vi.hoisted(() => ({ started: false, finished: false, runs: 0 }));
vi.mock("../../packages/broker/src/aws/broker-environment.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BrokerEnvironment>();
  return {
    ...actual,
    hydrateBrokerEnvironment: (env: Parameters<typeof actual.hydrateBrokerEnvironment>[0]) => {
      hydration.started = true;
      hydration.runs += 1;
      try {
        return actual.hydrateBrokerEnvironment(env);
      } finally {
        hydration.finished = true;
      }
    },
  };
});

/** Every variable the broker's code reads that a named environment's control plane does not pass as such. */
function builtNames(): Set<string> {
  const names = new Set<string>();
  for (const spec of [...Object.values(BROKER_NAMES), ...Object.values(BROKER_SETTINGS)]) if (spec.variable !== "ROVARA_CORE_ALLOWED_COMPANIES") names.add(spec.variable);
  for (const derived of DERIVED_BROKER_VARIABLES) names.add(derived.variable);
  return names;
}

describe("the broker entry module reads no packed name before it unpacks them", () => {
  it("imports the environment init first, before any other import", () => {
    const source = readFileSync(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import\s[^;]*?["']([^"']+)["'];/gmu)].map((match) => match[1]);
    expect(imports[0]).toBe("./broker-environment-init.js");
  });

  // ENV-ROOM 2: the Lambda's entry is broker-handler.ts, which reads the names from their SSM parameter before broker.ts loads. It must load nothing of the broker before that:
  // its only static imports are the SDK's SSM client and the reader, which imports only the contracts (and a type).
  it("enters through broker-handler.ts, which loads broker.ts only after it has read the names", () => {
    const handler = readFileSync(new URL("../../packages/broker/src/aws/broker-handler.ts", import.meta.url), "utf8");
    expect([...handler.matchAll(/^import\s(?!type\s)[^;]*?["']([^"']+)["'];/gmu)].map((match) => match[1])).toEqual(["@aws-sdk/client-ssm", "./broker-names-parameter.js"]);
    expect([...handler.matchAll(/import\(\s*["']([^"']+)["']\s*\)/gu)].map((match) => match[1])).toEqual(["./broker.js"]);
    const reader = readFileSync(new URL("../../packages/broker/src/aws/broker-names-parameter.ts", import.meta.url), "utf8");
    expect([...reader.matchAll(/^import\s(?!type\s)[^;]*?["']([^"']+)["'];/gmu)].map((match) => match[1])).toEqual(["@agentx/contracts"]);
    const infra = readFileSync(new URL("../../infra/lib/control-plane.ts", import.meta.url), "utf8");
    expect(infra).toContain('packagedFunction(this, "Broker", "packages/broker/src/aws/broker-handler.ts"');
  });

  it("hydrates the packed settings before the dispatcher's first import can read them", () => {
    const source = readFileSync(new URL("../../packages/broker/src/aws/dispatcher.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import\s[^;]*?["']([^"']+)["'];/gmu)].map((match) => match[1]);
    expect(imports[0]).toBe("./broker-environment-init.js");
  });

  describe("loaded the way the Lambda loads it", () => {
    const saved = process.env;
    const names = builtNames();
    const readsBefore: string[] = [];
    let readsAfter = 0;

    let parameterValue = "";
    beforeAll(() => {
      const { functions, template, resolver } = controlPlaneOf("staging", synthesized("staging"));
      const broker = functions.find((entry) => entry.logicalId.startsWith("Broker"))!;
      const parameter = brokerNamesParameterOf(template, broker.variables.AGENTX_NAMES_PARAMETER!);
      parameterValue = resolver.text((template.Resources[parameter.id]!.Properties as { Value: unknown }).Value);
      const environment: Record<string, string | undefined> = { ...saved };
      for (const name of names) delete environment[name];
      Object.assign(environment, broker.variables, { AWS_REGION: RESOLVER_REGION });
      // The switch is packed (sw, core switch-on blocker 2026-11-17): off, as before, so the entry module builds no core.
      environment.AGENTX_SETTINGS = environment.AGENTX_SETTINGS!.replace(/(^|,)sw=[^,]*/u, "$1sw=off");
      const record = (key: string | symbol): void => {
        if (typeof key !== "string" || !names.has(key)) return;
        if (!hydration.started) readsBefore.push(key);
        else if (hydration.finished) readsAfter += 1;
      };
      process.env = new Proxy(environment, {
        get(target, key, receiver): unknown {
          record(key);
          return Reflect.get(target, key, receiver) as unknown;
        },
        has(target, key) {
          record(key);
          return Reflect.has(target, key);
        },
      });
    });
    afterAll(() => {
      process.env = saved;
    });

    it("starts from an environment that has the names only packed (in their parameter)", () => {
      expect(Object.keys(process.env).filter((key) => names.has(key))).toEqual([]);
      readsAfter = 0;
      readsBefore.length = 0;
    });

    it("hydrates once, and nothing reads a packed name before that", async () => {
      vi.resetModules();
      hydration.started = false;
      hydration.finished = false;
      hydration.runs = 0;
      // As broker-handler.ts does: the names from their parameter, then broker.ts.
      await loadBrokerNamesParameter(process.env, async () => ({ type: "String", value: parameterValue }));
      await import("../../packages/broker/src/aws/broker.js");
      expect(hydration.runs).toBe(1);
      expect(hydration.finished).toBe(true);
      // The positive control: the proxy does see reads of built names, so an empty list means none were made.
      expect(readsAfter).toBeGreaterThan(0);
      expect(readsBefore).toEqual([]);
    }, 120_000);
  });
});
