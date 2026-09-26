import { beforeAll, describe, expect, it } from "vitest";
import { ENVIRONMENT_PLACEHOLDER, ENVIRONMENT_PLACEHOLDER_UNDERSCORED, EnvironmentNameSchema, renderTemplate } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";

function templates(env: string): Map<string, string> {
  const assembly = buildAgentXApp({ agentxEnv: env, agentxSynthesizer: "legacy" }).synth();
  const byPart = new Map<string, string>();
  for (const stack of assembly.stacks) {
    const part = stack.stackName.replace(`agentx-${env}-`, "");
    byPart.set(part, JSON.stringify(stack.template));
  }
  return byPart;
}

describe("templates for any environment", () => {
  // Synthesizing the whole app bundles four Lambdas with esbuild per synth (slow). The placeholder
  // app is identical across every test in this file, so it is synthesized once here and reused,
  // instead of once per test/case as the brief's inline snippet would (this changes nothing about
  // what each test asserts).
  let placeholderTemplates: Map<string, string>;

  beforeAll(() => {
    placeholderTemplates = templates(ENVIRONMENT_PLACEHOLDER);
  }, 300_000);

  it("uses a placeholder that is a valid name and that no real environment can take", () => {
    expect(ENVIRONMENT_PLACEHOLDER).toBe("qqenv-placeholderqq");
    expect(ENVIRONMENT_PLACEHOLDER_UNDERSCORED).toBe("qqenv_placeholderqq");
    expect(EnvironmentNameSchema.safeParse(ENVIRONMENT_PLACEHOLDER).success).toBe(true);
    expect(EnvironmentNameSchema.safeParse("myqqenv").success).toBe(false);
  });

  it("needs no CDK bootstrap and takes code package locations as parameters", () => {
    for (const [part, text] of placeholderTemplates) {
      expect(text, part).not.toContain("cdk-hnb659fds");
      expect(text, part).not.toContain("BootstrapVersion");
    }
    expect(placeholderTemplates.get("control-plane")).toMatch(/AssetParameters[0-9a-f]{64}S3Bucket/);
  }, 300_000);

  it.each(["staging", "dev-2"])("renders to exactly what CDK synthesizes for %s", (env) => {
    const direct = templates(env);
    expect([...placeholderTemplates.keys()].sort()).toEqual([...direct.keys()].sort());
    for (const [part, text] of placeholderTemplates) {
      expect(renderTemplate(text, env), part).toBe(direct.get(part));
    }
  }, 600_000);

  it("refuses an invalid environment and refuses output that still holds the placeholder", () => {
    expect(() => renderTemplate("x", "Bad")).toThrow(/environment name/);
    expect(() => renderTemplate("qqenv", "staging")).toThrow(/placeholder/);
  });

  it("is refused for the deployment that predates environments", () => {
    expect(() => buildAgentXApp({ agentxSynthesizer: "legacy" })).toThrow(/named environment/);
  });

  it("refuses an unsupported agentxSynthesizer value, naming it", () => {
    expect(() => buildAgentXApp({ agentxEnv: "staging", agentxSynthesizer: "bogus" })).toThrow(/bogus/);
  });
});

/**
 * `cdk synth -c agentxEnv=... -c agentxSynthesizer=legacy` reaches bin/agentx.ts, which calls
 * buildAgentXApp() with no arguments at all: the `cdk` CLI passes `-c` flags (and cdk.json) to the
 * app it shells out to via the CDK_CONTEXT_JSON environment variable, not by calling this function
 * with a context object. Reading only the function argument (as buildAgentXApp did before) silently
 * ignored that entirely and produced bootstrap-dependent templates instead of honoring or refusing
 * the request.
 */
describe("agentxSynthesizer from CDK_CONTEXT_JSON (how the cdk CLI actually passes -c flags)", () => {
  function withCdkContextJson(value: Record<string, unknown>, run: () => void): void {
    const original = process.env.CDK_CONTEXT_JSON;
    try {
      process.env.CDK_CONTEXT_JSON = JSON.stringify(value);
      run();
    } finally {
      if (original === undefined) delete process.env.CDK_CONTEXT_JSON;
      else process.env.CDK_CONTEXT_JSON = original;
    }
  }

  it("synthesizes bootstrap-free templates from agentxEnv/agentxSynthesizer alone", () => {
    withCdkContextJson({ agentxEnv: "staging", agentxSynthesizer: "legacy" }, () => {
      const assembly = buildAgentXApp().synth();
      const text = assembly.stacks.map((stack) => JSON.stringify(stack.template)).join("\n");
      expect(text).not.toContain("cdk-hnb659fds");
      expect(text).not.toContain("BootstrapVersion");
    });
  }, 300_000);

  it("refuses an unsupported agentxSynthesizer value, naming it", () => {
    withCdkContextJson({ agentxEnv: "staging", agentxSynthesizer: "bogus" }, () => {
      expect(() => buildAgentXApp()).toThrow(/bogus/);
    });
  });

  it("refuses agentxSynthesizer=legacy with no named environment", () => {
    withCdkContextJson({ agentxSynthesizer: "legacy" }, () => {
      expect(() => buildAgentXApp()).toThrow(/named environment/);
    });
  });
});
