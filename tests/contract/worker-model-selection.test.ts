import { describe, expect, it } from "vitest";
import { resolveTaskModel,parseTaskModelFallbackAuthorization } from "../../packages/worker/src/task-model.js";

describe("worker task model resolution", () => {

  it("returns the selection's level when given, for any provider", () => {
    expect(resolveTaskModel({ provider: "openrouter", modelId: "qwen/qwen3-coder", thinkingLevel: "high" }, {})).toMatchObject({ thinkingLevel: "high" });
    expect(resolveTaskModel({ provider: "amazon-bedrock", modelId: "m", thinkingLevel: "off" }, {})).toMatchObject({ thinkingLevel: "off" });
  });

  it.each([["anthropic", "claude-sonnet-4-6"]])("lets the session choose the level from the catalog for a %s model", (provider, modelId) => {
    expect(resolveTaskModel({ provider, modelId }, {})).not.toHaveProperty("thinkingLevel");
    expect(resolveTaskModel(undefined, { AGENTX_MODEL_PROVIDER: provider, AGENTX_MODEL_ID: modelId })).not.toHaveProperty("thinkingLevel");
  });

});

it("C53 accepts only the authorization for this operation's frozen model binding",()=>{
 const binding={version:1 as const,stage:"build" as const,companyRevision:3,recipeDigest:"a".repeat(64)},model={provider:"amazon-bedrock",modelId:"us.anthropic.claude-sonnet-4-6"};
 const reply={version:1,binding,model,sourcesRevision:2};
 expect(parseTaskModelFallbackAuthorization(reply,binding)).toEqual(reply);
 for(const raw of [{recorded:true},{...reply,allowed:true},{...reply,binding:{...binding,stage:"plan"}},{...reply,binding:{...binding,companyRevision:4}},{...reply,binding:{...binding,recipeDigest:"b".repeat(64)}}])expect(()=>parseTaskModelFallbackAuthorization(raw,binding)).toThrow("fallback authorization");
});
