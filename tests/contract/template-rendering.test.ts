import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONTEXT_ENV, CONTEXT_OVERFLOW_LOCATION_ENV } from "aws-cdk-lib/cx-api";
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

function withCdkContextJson(value: Record<string, unknown>, run: () => void): void {
  const original = process.env[CONTEXT_ENV];
  try {
    process.env[CONTEXT_ENV] = JSON.stringify(value);
    run();
  } finally {
    if (original === undefined) delete process.env[CONTEXT_ENV];
    else process.env[CONTEXT_ENV] = original;
  }
}

/** Simulates CDK's own context-overflow temp file (used instead of CDK_CONTEXT_JSON when the
 * context is too large for an environment variable): writes `value` to a temp JSON file and points
 * CONTEXT_OVERFLOW_LOCATION_ENV at it for the duration of `run`. */
function withContextOverflowFile(value: Record<string, unknown>, run: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), "agentx-context-overflow-"));
  const file = join(dir, "context-overflow.json");
  writeFileSync(file, JSON.stringify(value));
  const original = process.env[CONTEXT_OVERFLOW_LOCATION_ENV];
  try {
    process.env[CONTEXT_OVERFLOW_LOCATION_ENV] = file;
    run();
  } finally {
    if (original === undefined) delete process.env[CONTEXT_OVERFLOW_LOCATION_ENV];
    else process.env[CONTEXT_OVERFLOW_LOCATION_ENV] = original;
    rmSync(dirname(file), { recursive: true, force: true });
  }
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

  it("refuses to render the identity template (which carries a Cognito hosted UI domain) for an environment name Cognito would reject, even though the placeholder synth itself succeeded", () => {
    const identityText = placeholderTemplates.get("identity");
    expect(identityText).toContain("AWS::Cognito::UserPoolDomain");
    expect(() => renderTemplate(identityText!, "aws-dev")).toThrow(/Cognito domain/);
  });

  it("renders a non-identity template (no Cognito user pool domain) for that same environment name without issue", () => {
    const foundationText = placeholderTemplates.get("foundation");
    expect(foundationText).not.toContain("AWS::Cognito::UserPoolDomain");
    expect(() => renderTemplate(foundationText!, "aws-dev")).not.toThrow();
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

  it("gives CDK_CONTEXT_JSON precedence over the context argument for the pre-App guard, matching how App itself merges context for every other key", () => {
    withCdkContextJson({ agentxSynthesizer: "bogus" }, () => {
      // The context argument's agentxSynthesizer disagrees with CDK_CONTEXT_JSON's. Once
      // `new App(...)` runs, App.loadContext would give CDK_CONTEXT_JSON the final say for every
      // other context key regardless of what this argument says, so the pre-App guard (which must
      // decide the synthesizer before construction) has to honor the same precedence: it must
      // reject "bogus", not silently accept the argument's "legacy".
      expect(() => buildAgentXApp({ agentxSynthesizer: "legacy", agentxEnv: "staging" })).toThrow(/bogus/);
    });
  });

  it("throws a clear error naming CDK_CONTEXT_JSON when it is malformed, instead of a raw SyntaxError", () => {
    const original = process.env[CONTEXT_ENV];
    try {
      process.env[CONTEXT_ENV] = "{not json";
      expect(() => buildAgentXApp({ agentxEnv: "staging", agentxSynthesizer: "legacy" })).toThrow(new RegExp(CONTEXT_ENV));
    } finally {
      if (original === undefined) delete process.env[CONTEXT_ENV];
      else process.env[CONTEXT_ENV] = original;
    }
  });
});

describe("context-overflow temp file (App's own readContextFromTempFile, layered like App.loadContext)", () => {
  it("is read the same way App reads it, and feeds the pre-App guard clauses", () => {
    withContextOverflowFile({ agentxSynthesizer: "legacy", agentxEnv: "overflow-env" }, () => {
      const app = buildAgentXApp();
      expect(app.node.tryGetContext("agentxEnv")).toBe("overflow-env");
    });
  });

  it("wins over CDK_CONTEXT_JSON for a key both set, matching App.loadContext's own layering ({...environment, ...tempFile})", () => {
    withCdkContextJson({ agentxSynthesizer: "bogus" }, () => {
      withContextOverflowFile({ agentxSynthesizer: "legacy", agentxEnv: "staging" }, () => {
        // If CDK_CONTEXT_JSON still won, this would throw naming "bogus" instead.
        expect(() => buildAgentXApp()).not.toThrow();
      });
    });
  });

  it(`throws a clear error naming ${CONTEXT_OVERFLOW_LOCATION_ENV} when the file it points to is not valid JSON`, () => {
    const dir = mkdtempSync(join(tmpdir(), "agentx-context-overflow-bad-"));
    const file = join(dir, "context-overflow.json");
    writeFileSync(file, "{not json");
    const original = process.env[CONTEXT_OVERFLOW_LOCATION_ENV];
    try {
      process.env[CONTEXT_OVERFLOW_LOCATION_ENV] = file;
      expect(() => buildAgentXApp({ agentxEnv: "staging", agentxSynthesizer: "legacy" })).toThrow(
        new RegExp(CONTEXT_OVERFLOW_LOCATION_ENV),
      );
    } finally {
      if (original === undefined) delete process.env[CONTEXT_OVERFLOW_LOCATION_ENV];
      else process.env[CONTEXT_OVERFLOW_LOCATION_ENV] = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores an empty value, matching App's own readContextFromTempFile (`location ? ... : {}`)", () => {
    const original = process.env[CONTEXT_OVERFLOW_LOCATION_ENV];
    try {
      process.env[CONTEXT_OVERFLOW_LOCATION_ENV] = "";
      expect(() => buildAgentXApp({ agentxEnv: "staging", agentxSynthesizer: "legacy" })).not.toThrow();
    } finally {
      if (original === undefined) delete process.env[CONTEXT_OVERFLOW_LOCATION_ENV];
      else process.env[CONTEXT_OVERFLOW_LOCATION_ENV] = original;
    }
  });
});

describe("outdir context (buildAgentXApp forwards it to `new App({ outdir })`)", () => {
  it("defaults to a fresh temporary directory when no outdir context is given, unchanged from before", () => {
    const first = buildAgentXApp({ agentxSynthesizer: "legacy", agentxEnv: "staging" });
    const second = buildAgentXApp({ agentxSynthesizer: "legacy", agentxEnv: "staging" });
    expect(first.outdir).toMatch(/cdk\.out/);
    expect(second.outdir).toMatch(/cdk\.out/);
    // Two apps built with no outdir context each get their own ephemeral directory: proof this is
    // still App's own default, not something buildAgentXApp now pins by accident.
    expect(first.outdir).not.toBe(second.outdir);
  });

  it("honors an explicit outdir context key", () => {
    const outdir = mkdtempSync(join(tmpdir(), "agentx-outdir-context-"));
    try {
      const app = buildAgentXApp({ agentxSynthesizer: "legacy", agentxEnv: "staging", outdir });
      expect(app.outdir).toBe(outdir);
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });
});
