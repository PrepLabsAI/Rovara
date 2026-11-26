// #1478 phase 2, point 3: the gateway stack records the Code commit it was deployed from as its own DeployedCodeSha output. The output adds no resource, and without the context
// (a hand deploy, every pinned template) the template is what it was. The Cloud sha is not recorded here any more (Cloud's live sha is read from Cloud's web stack only).
import type { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { MODEL_GATEWAY_CONTEXT_KEY, MODEL_GATEWAY_PRODUCT_CONTEXT_KEY } from "../../infra/lib/model-gateway.js";

// The names are written out, not imported (the context key, the output names): the release pipeline (Cloud) reads these exact strings from the stack, so renaming a constant must fail here.
const CODE_SHA_CONTEXT_KEY = "rovaraCodeSha";
const DEPLOYED_CODE_SHA_OUTPUT = "DeployedCodeSha";
const GATEWAY_SERVICE_ARN_OUTPUT = "ServiceArn";

interface Template_ { Resources: Record<string, unknown>; Outputs?: Record<string, { Value: unknown; Description?: string }>; Parameters?: Record<string, unknown> }
const CODE = "c".repeat(40);
const synth = (context: Record<string, unknown>, env = "staging"): Template_ =>
  Template.fromStack(buildAgentXApp({ [MODEL_GATEWAY_CONTEXT_KEY]: env, [MODEL_GATEWAY_PRODUCT_CONTEXT_KEY]: "on", agentxRegion: "us-east-1", ...context }).node.findChild("RovaraModelGateway") as Stack).toJSON() as Template_;

describe("the gateway's DeployedCodeSha output", () => {
  const plain = synth({});
  const stamped = synth({ [CODE_SHA_CONTEXT_KEY]: CODE });

  it("names the Code commit, with the service its settled gate reads, and nothing else is new", () => {
    expect(stamped.Outputs?.[DEPLOYED_CODE_SHA_OUTPUT]).toMatchObject({ Value: CODE });
    expect(stamped.Outputs?.[GATEWAY_SERVICE_ARN_OUTPUT]).toBeDefined();
    const added = Object.keys(stamped.Outputs ?? {}).filter((name) => !(name in (plain.Outputs ?? {}))).sort();
    expect(added).toEqual([DEPLOYED_CODE_SHA_OUTPUT, GATEWAY_SERVICE_ARN_OUTPUT]);
  });

  it("changes no resource, parameter or rule: the templates are equal apart from the outputs", () => {
    const withoutOutputs = (template: Template_): Record<string, unknown> => Object.fromEntries(Object.entries(template).filter(([section]) => section !== "Outputs"));
    expect(withoutOutputs(stamped)).toEqual(withoutOutputs(plain));
  });

  it("without the context there is neither output (a hand deploy, and every pinned template, are as they were)", () => {
    expect(plain.Outputs?.[DEPLOYED_CODE_SHA_OUTPUT]).toBeUndefined();
    expect(plain.Outputs?.[GATEWAY_SERVICE_ARN_OUTPUT]).toBeUndefined();
  });

  it("never writes the Cloud sha: -c rovaraCloudSha is read by nothing, and DeployedCloudSha does not exist", () => {
    const withCloud = synth({ rovaraCloudSha: "d".repeat(40), [CODE_SHA_CONTEXT_KEY]: CODE });
    expect(withCloud).toEqual(stamped);
    expect(JSON.stringify(stamped)).not.toContain("DeployedCloudSha");
    expect(JSON.stringify(synth({ rovaraCloudSha: "d".repeat(40) }))).toEqual(JSON.stringify(plain));
  });

  it("a context that is not a 40-hex commit stops the synth (an output that names no commit would be worse than none)", () => {
    for (const bad of ["main", "C".repeat(40), "c".repeat(39), 5, ""]) expect(() => synth({ [CODE_SHA_CONTEXT_KEY]: bad }), String(bad)).toThrow(/rovaraCodeSha must be a 40-character lowercase hex commit sha/);
  });

  it("holds for production too (the same stack, the same output)", () => {
    const production = synth({ [CODE_SHA_CONTEXT_KEY]: CODE, rovaraAiSourceKinds: "openai" }, "production");
    expect(production.Outputs?.[DEPLOYED_CODE_SHA_OUTPUT]).toMatchObject({ Value: CODE });
  });
});
