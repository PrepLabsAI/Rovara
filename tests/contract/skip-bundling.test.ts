import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { packagedFunction } from "../../infra/lib/control-plane.js";
import { BUNDLING_STACKS_KEY, contextJsonWithoutBundling, skipLambdaBundling } from "../support/skip-bundling.js";

// A synth that bundles a Lambda runs esbuild for it, which is most of the time a CDK test takes.
// A test that only checks a template's shape does not need the bundle, so it may skip it; a test
// that reads the bundle (the release builder's, the session lifecycle's) must not. These tests keep
// both paths honest: bundling still produces the handler, and skipping it changes nothing else.
const ENTRY = "packages/broker/src/aws/developer-identity.ts";

function synthProbe(context: Record<string, unknown>): { assetDirs: string[]; template: string; directory: string } {
  const app = new App({ context });
  const stack = new Stack(app, "Probe");
  packagedFunction(stack, "Handler", ENTRY, {});
  const directory = app.synth().directory;
  const assetDirs = readdirSync(directory).filter((name) => name.startsWith("asset."));
  return { assetDirs, template: JSON.stringify(Template.fromStack(stack).toJSON()), directory };
}

describe("bundling a Lambda in a CDK test", () => {
  it("really bundles by default: the staged asset holds the built handler", () => {
    const { assetDirs, directory } = synthProbe({});
    expect(assetDirs).toHaveLength(1);
    expect(existsSync(join(directory, assetDirs[0]!, "index.js"))).toBe(true);
  }, 60_000);

  it("stages no code when the bundling-stacks context is empty, and the template still names an asset hash", () => {
    const { assetDirs, template } = synthProbe({ [BUNDLING_STACKS_KEY]: [] });
    expect(assetDirs).toEqual([]);
    expect(template).toMatch(/[a-f0-9]{64}/);
  }, 60_000);

  it("gives the same template shape either way once asset hashes are normalised", () => {
    const normalised = (text: string) => text.replace(/[a-f0-9]{64}/g, "<asset-hash>");
    expect(normalised(synthProbe({ [BUNDLING_STACKS_KEY]: [] }).template)).toBe(normalised(synthProbe({}).template));
  }, 60_000);
});

describe("skipLambdaBundling", () => {
  it("adds the context key to CDK_CONTEXT_JSON and keeps the keys already there", () => {
    const merged = JSON.parse(contextJsonWithoutBundling('{"agentxEnv":"staging","other":[1]}')) as Record<string, unknown>;
    expect(merged).toEqual({ agentxEnv: "staging", other: [1], [BUNDLING_STACKS_KEY]: [] });
  });

  it("starts from nothing when CDK_CONTEXT_JSON is unset or empty", () => {
    expect(JSON.parse(contextJsonWithoutBundling(undefined))).toEqual({ [BUNDLING_STACKS_KEY]: [] });
    expect(JSON.parse(contextJsonWithoutBundling(""))).toEqual({ [BUNDLING_STACKS_KEY]: [] });
  });

  it("refuses a CDK_CONTEXT_JSON that is not a JSON object, rather than silently replacing it", () => {
    expect(() => contextJsonWithoutBundling("not json")).toThrow(/CDK_CONTEXT_JSON/);
    expect(() => contextJsonWithoutBundling("[1]")).toThrow(/CDK_CONTEXT_JSON/);
  });

  it("sets the environment now and puts back what was there afterwards", () => {
    const had: NodeJS.ProcessEnv = { CDK_CONTEXT_JSON: '{"a":1}' };
    let restoreHad!: () => void;
    skipLambdaBundling(had, (restore) => { restoreHad = restore; });
    expect(JSON.parse(had.CDK_CONTEXT_JSON!)).toEqual({ a: 1, [BUNDLING_STACKS_KEY]: [] });
    restoreHad();
    expect(had.CDK_CONTEXT_JSON).toBe('{"a":1}');

    const hadNone: NodeJS.ProcessEnv = {};
    let restoreNone!: () => void;
    skipLambdaBundling(hadNone, (restore) => { restoreNone = restore; });
    expect(JSON.parse(hadNone.CDK_CONTEXT_JSON!)).toEqual({ [BUNDLING_STACKS_KEY]: [] });
    restoreNone();
    expect("CDK_CONTEXT_JSON" in hadNone).toBe(false);
  });
});
